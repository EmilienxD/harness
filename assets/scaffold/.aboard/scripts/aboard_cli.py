"""aboard's Manager CLI — the delegation surface, as a command instead of an MCP server.

This is the only way an agent reaches the bridge's orchestration actions:
launching a visible worker, editing the project roadmap, starting an automatic
implementation run, reopening the session that owns a pull request, and breaking
a stuck write lease.

It replaced an MCP server for two reasons. An MCP server is registered per
project, so it entered every session in the workspace — the user's own `claude`
included — and its tool list competed with the MCP servers the user configured
themselves. And its tool schemas were paid for in every one of those sessions'
context windows, whether or not the session could act on them. A command is
carried by nothing: only the Manager's system prompt documents it, only the
Manager's terminal carries `ABOARD_CLI`, and the bridge refuses any caller that
is not the recorded Manager.

Invoked as:

    uv run --no-project "$ABOARD_CLI" <command> [options]

A launch prompt accepts `-` to read the value from stdin, which is how a
multi-line document reaches the bridge without being escaped onto a command
line. Roadmap subjects are single-line by construction and take no such path.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# The bridge route each command posts to. Commands are named, never spelled as
# paths on the command line: Claude Code runs Bash through Git Bash on Windows,
# and MSYS rewrites a bare argument that looks like a POSIX path, so a `/cli/...`
# argument would arrive as `C:/Program Files/Git/cli/...`.
ROUTES = {
    "agent": "/cli/agent",
    "todo create": "/cli/todo-create",
    "todo update": "/cli/todo-update",
    "auto": "/cli/auto-run",
    "review": "/cli/review-pr",
    "release-lease": "/cli/release-lease",
}

# A foreground launch blocks for as long as the worker runs, which is bounded by
# the Manager's Stop hook timeout rather than by anything here. Every other
# command is a bounded bridge call that may shell out to `gh`.
FOREGROUND_TIMEOUT_SECONDS = 3600
DEFAULT_TIMEOUT_SECONDS = 120


def text_argument(value):
    """`-` means "read this value from stdin", for text too long to quote."""
    if value != "-":
        return value
    return sys.stdin.read()


def build_parser():
    parser = argparse.ArgumentParser(
        prog="aboard",
        description="aboard's delegation surface. Reaches the bridge running in the VS Code extension host.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    agent = commands.add_parser(
        "agent",
        help="Launch a visible, independent Claude Code agent in its own terminal.",
    )
    agent.add_argument("--type", required=True, help="Agent type to launch.")
    agent.add_argument("--description", required=True, help="3-6 words, shown in the fleet tree.")
    agent.add_argument("--prompt", help="The agent's first user turn. Required unless --interactive. `-` reads it from stdin.")
    agent.add_argument("--issue", type=int, help="GitHub issue whose resolved contract is merged into the launch prompt.")
    agent.add_argument("--interactive", action="store_true", help="Hand the terminal to the user. No result is ever delivered.")
    agent.add_argument("--background", action="store_true", help="Return immediately; the result arrives at a later turn boundary.")

    todo = commands.add_parser("todo", help="Add to or edit the project roadmap, one task at a time.")
    todo_commands = todo.add_subparsers(dest="todo_command", required=True)

    # `--subject` repeats so a bootstrap writes ten or twenty items in one spawn
    # and one issue revision, rather than twenty of each. Discrete flags beat a
    # newline-delimited stdin contract: they are easier to emit correctly.
    todo_create = todo_commands.add_parser("create", help="Add one or more tasks to the roadmap.")
    todo_create.add_argument("--subject", action="append", required=True, metavar="TEXT",
                             help="One task, one short sentence. Repeat for several. Single-quote it; write '\\'' for each apostrophe.")
    todo_create.add_argument("--after", metavar="ID|top", help="Place the new tasks after this task id, or at `top`. Default appends.")

    todo_update = todo_commands.add_parser("update", help="Edit, complete, delete, or move one roadmap task.")
    todo_update.add_argument("--task", required=True, metavar="ID", help="The 4-character task id, copied from the roadmap block.")
    todo_update.add_argument("--subject", metavar="TEXT", help="Replacement text. This changes the task's id.")
    todo_update.add_argument("--status", choices=["pending", "completed", "deleted", "in_progress"],
                             help="pending, completed, or deleted. in_progress is recorded as pending.")
    todo_update.add_argument("--after", metavar="ID|top", help="Move the task after this task id, or to `top`.")

    commands.add_parser("auto", help="Start the automatic implementation run for the oldest open spec issue.")

    review = commands.add_parser("review", help="Reopen the session that owns the pull request in flight and hand it to the user.")
    review.add_argument("--pr", type=int, help="Target a specific pull request instead of the latest open one.")
    review.add_argument("--focus", help="What the user wants looked at.")

    release = commands.add_parser("release-lease", help="Force-release the workspace write lease.")
    release.add_argument("--reason", required=True, help="Audit reason. Concurrent editing may become possible immediately.")

    return parser


def route_key(arguments):
    """`todo` dispatches on its subcommand; every other command is its own route."""
    if arguments.command == "todo":
        return "todo {0}".format(arguments.todo_command)
    return arguments.command


def request_for(arguments):
    """The bridge body and the wait this command needs, or an error message."""
    if arguments.command == "agent":
        prompt = None if arguments.prompt is None else text_argument(arguments.prompt)
        body = {"type": arguments.type, "description": arguments.description}
        if prompt is not None:
            body["prompt"] = prompt
        if arguments.issue is not None:
            body["issue"] = arguments.issue
        if arguments.interactive:
            body["interactive"] = True
        if arguments.background:
            body["run_in_background"] = True
        # Only a blocking foreground launch waits on the worker itself.
        timeout = DEFAULT_TIMEOUT_SECONDS if (arguments.interactive or arguments.background) else FOREGROUND_TIMEOUT_SECONDS
        return body, timeout
    if arguments.command == "todo":
        body = {}
        if arguments.todo_command == "create":
            body["subjects"] = arguments.subject
        else:
            body["task"] = arguments.task
            if arguments.subject is not None:
                body["subject"] = arguments.subject
            if arguments.status is not None:
                body["status"] = arguments.status
        if arguments.after is not None:
            body["after"] = arguments.after
        return body, DEFAULT_TIMEOUT_SECONDS
    if arguments.command == "auto":
        return {}, DEFAULT_TIMEOUT_SECONDS
    if arguments.command == "review":
        body = {}
        if arguments.pr is not None:
            body["pr"] = arguments.pr
        if arguments.focus is not None:
            body["focus"] = arguments.focus
        return body, DEFAULT_TIMEOUT_SECONDS
    return {"reason": arguments.reason}, DEFAULT_TIMEOUT_SECONDS


def fail(message):
    sys.stderr.write(message.rstrip() + "\n")
    return 1


def post(endpoint, body, timeout, port, token, agent_id):
    request = urllib.request.Request(
        "http://127.0.0.1:{0}{1}".format(port, endpoint),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": "Bearer {0}".format(token),
            "Content-Type": "application/json",
            # The bridge answers this surface only for the recorded Manager. It
            # is the structural half of the isolation the prompt describes.
            "X-Aboard-Agent-Id": agent_id,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def main(argv):
    arguments = build_parser().parse_args(argv)
    try:
        port = int(os.environ["ABOARD_BRIDGE_PORT"])
        token = os.environ["ABOARD_BRIDGE_TOKEN"]
        agent_id = os.environ["ABOARD_AGENT_ID"]
    except (KeyError, ValueError):
        return fail(
            "aboard is unreachable from this session: it was not started by the aboard extension, "
            "so the bridge address is not in the environment. Nothing was performed."
        )

    body, timeout = request_for(arguments)
    try:
        payload = post(ROUTES[route_key(arguments)], body, timeout, port, token, agent_id)
    except urllib.error.HTTPError as error:
        # The bridge reports refusals as JSON on a non-2xx status; a lease
        # conflict and an invalid argument both arrive here and both are the
        # caller's to read, so the message is surfaced verbatim.
        try:
            reported = json.load(error)
        except ValueError:
            reported = None
        if isinstance(reported, dict) and isinstance(reported.get("error"), dict):
            details = reported["error"].get("details")
            return fail(
                "{0}{1}".format(
                    reported["error"].get("message", "aboard refused the request."),
                    "" if details is None else "\n" + json.dumps(details, indent=2),
                )
            )
        return fail("aboard refused the request: HTTP {0}.".format(error.code))
    except (urllib.error.URLError, ConnectionError, TimeoutError, ValueError) as error:
        return fail("aboard could not reach the bridge: {0}. Nothing was performed.".format(error))

    if not isinstance(payload, dict) or "result" not in payload:
        return fail("aboard returned an unreadable response.")
    print(json.dumps(payload["result"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
