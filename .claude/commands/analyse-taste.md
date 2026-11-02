---
description: Scan the Taste Library source folder and analyse pending items
allowed-tools: Bash(npm run analyse:*)
---

Analyse the pending items in the Taste Library. Run this command from the Taste Library project folder and wait for it to finish (it can take a few minutes):

!`npm run analyse --silent`

Report the result in two or three lines: how many items were scanned as new, how many were analysed, and how many failed. If any failed, say the reason shown above and that they can be retried in the app. Do not do anything else.
