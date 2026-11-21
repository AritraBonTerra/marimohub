"""Print the runtime's locked non-dev distributions as JSON for the base image label."""

import json
import re
import subprocess

exported = subprocess.run(
    ["uv", "export", "--locked", "--no-dev", "--no-hashes", "--no-emit-project"],
    check=True,
    capture_output=True,
    text=True,
).stdout
names = sorted(
    {
        re.sub(r"[-_.]+", "-", match[1].lower())
        for line in exported.splitlines()
        if (match := re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==", line))
    }
)
print(json.dumps(names))
