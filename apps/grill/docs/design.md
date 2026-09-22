# Grill-Me board design

Grill-Me board should feel like a calm, tactile review desk: warm paper, crisp ink, and a small amount of vivid color for state. The interface is utilitarian but not sterile. Decisions must remain easier to scan than the surrounding chrome.

## Principles

- Keep the current question central. Navigation, history, and delivery status are supporting information.
- Make state explicit in words as well as color: recommended, selected, queued, read only, online, and error.
- Preserve a paper-and-card character through solid borders, restrained shadows, and compact radii.
- Prefer short labels and direct verbs. Use **Queue answer**, **Update answer**, **Review prompt**, **Copy prompt**, and **Send via Aboard** consistently.
- Keep destructive actions visually separate and require confirmation.

## Color

The core palette is:

| Role | Color | Use |
| --- | --- | --- |
| Paper | `#f5f3ee` | Page background |
| Raised paper | `#e8e4dd` | Navigation rail and secondary surfaces |
| Paper edge | `#ded8cf` | Quiet borders and dividers |
| Surface | `#fbfaf6` | Cards, inputs, dialogs, and rows |
| Ink | `#2d2d2d` | Body text and softer dark controls |
| Strong ink | `#0d0d0d` | Headings, primary actions, card outlines, and shadows |
| Muted ink | `#55524c` | Supporting copy and metadata |
| Faint ink | `#736f68` | Low-priority labels and disabled text |
| Accent | `#5b53ff` | Focus, active selection, links, and recommendations |
| Accent wash | `#e6e5ff` | Selected and recommendation backgrounds |
| Success | `#12b76a` | Queued answers and live presence |
| Success wash | `#dbf4e9` | Queued-state backgrounds |
| Danger | `#c0392b` | Errors and destructive intent |

Use strong ink for the primary action instead of accent purple. Accent identifies focus and choice; success identifies committed answer state. Do not rely on either alone—pair them with a label, icon, or status text.

## Typography

Use Space Grotesk for headings, compact labels, badges, and navigation. Use DM Sans for body copy, form controls, and explanations. System sans-serif is the fallback for both.

Headings are compact and medium-to-semibold rather than oversized. Supporting labels are often uppercase with generous letter spacing. Body copy should stay comfortable at roughly 13–15px with increased line height for long explanations. Prompt previews use a monospace stack and preserve whitespace.

## Layout

Desktop uses a fixed session rail beside a fluid content area. The content column is centered, capped at a readable width, and scrolls independently. Historical rounds appear above the active round in chronological order; a strong divider marks the change to the editable round.

On screens narrower than the desktop breakpoint, the session rail becomes an overlay drawer with a scrim. Explanatory grids collapse to one column, actions wrap or become full-width, and dialogs reduce their padding. The four access-code fields must remain usable on narrow phones.

Question rounds use a card-deck metaphor. A small number of rotated paper edges may peek behind the active card, then disappear as the user reaches the end of the round. Only one question is visible at a time. Question navigation shows a compact window of nearby IDs rather than an unbounded row.

## Surfaces and controls

Cards and dialogs use the light surface color, a dark 1.5px outline, a small radius, and a hard offset shadow. Secondary rows and inputs use quiet paper-colored borders without the heavy shadow.

Buttons follow four conventions:

- **Primary:** dark fill, light text, used for committing the next meaningful action.
- **Secondary:** light surface, dark border, used for review and reversible alternatives.
- **Icon:** compact transparent square with a quiet border and an accessible label.
- **Destructive:** dark red fill and white text, used only inside a confirmation dialog.

Disabled buttons retain their shape but lower their opacity and never move on hover. Text links use the accent color and are reserved for low-emphasis actions such as switching to a custom answer.

Options are full-row radio targets. A checked option receives an accent border and wash. Recommendations use an accent badge but never begin selected. A queued selection adds a green **Selected** badge. Historical controls remain visible but disabled so the past decision can still be understood.

## Feedback and motion

Motion is quick and functional:

- Hovered rows and buttons lift by one pixel.
- Pressed primary actions move down by one pixel.
- Question changes settle over about 260ms.
- Loading indicators rotate continuously.
- An invalid access code may shake briefly.

Keep control transitions near 120ms. Honor reduced-motion preferences: remove the question transition and all animation or transition supplied inside agent-authored explanations. Loading feedback may remain when needed to communicate ongoing work.

Show errors near the action that caused them when possible; use the page banner for loading or session-level failures. Temporary success feedback should be concise, such as a copied icon or a delivery-queued message. Never describe terminal submission as provider receipt.

## Explanation content

Agent-authored explanations may include paragraphs, headings, two-column grids, panels, notes, tables, figures, code, details, and small interactive demonstrations. They inherit the board typography and must stay inside the card width. Wide tables and code scroll horizontally; media scales down without stretching.

Interactive explanation content is illustrative only. It must not imitate answer controls or imply that it queued an answer. If initialization fails, show a small visible error for that question without blocking the rest of the round.

## Accessibility

- Every icon-only action needs an accessible name.
- Focus uses a visible accent ring and must not be removed without replacement.
- Dialogs use modal semantics, close on Escape where appropriate, and keep destructive confirmation distinct from prompt review.
- Touch targets should remain comfortably usable even when their visible icon is small.
- Maintain readable contrast on paper tones and never encode state by color alone.
- Preserve semantic headings, radio groups, labels, status messages, and read-only/disabled states.

## Voice

Copy is plain, compact, and literal. Prefer “queued,” “read only,” “submitted to terminal,” and “awaiting input” over celebratory or agent-like language. The board is a review instrument; it should report what happened without claiming more than it knows.
