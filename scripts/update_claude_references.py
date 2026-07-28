from pathlib import Path
import re
import requests

root = Path("docs/CLAUDE-REFERENCES")
readme_path = root / "README.md"

readme = readme_path.read_text(encoding="utf-8")

pattern = re.compile(
    r"\[([^\]]+)\]\(\./([^)]+)\)\s*\n\s*-\s*Source:\s*(https://\S+)",
    re.MULTILINE
)

matches = pattern.findall(readme)

if not matches:
    print("No references found. Check README.md format.")
    exit(1)

for display_name, local_file, url in matches:
    print(f"Fetching {url}")

    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()

        output_file = root / local_file
        output_file.write_text(response.text, encoding="utf-8")

        print(f"Saved {output_file}")

    except requests.RequestException as e:
        print(f"Failed to fetch {url}: {e}")

print(f"\nUpdated {len(matches)} files.")