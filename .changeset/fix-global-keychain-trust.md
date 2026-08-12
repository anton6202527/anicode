---
"anicode": patch
---

Fix globally installed CLI startup by resolving the native OS Keychain loader from the real package bundle instead of the npm bin symlink. Starting AniCode from the user's home directory also no longer misclassifies user-level skill symlinks as untrusted project execution input.
