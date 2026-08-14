---
"anicode": patch
---

Reduce CLI startup work by using a narrow core runtime entry, loading the OpenAI SDK only on first provider dispatch, and deferring the React/Ink frontend for headless commands.
