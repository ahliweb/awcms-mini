---
"awcms-mini": patch
---

fix(release): GitHub Release title = tag name, so tag and Release match (#825)

`gh release create` titled the Release `awcms-mini <version>` while the git
tag was `vX.Y.Z`, so the tag and its Release read differently. Title now
uses `github.ref_name` (the `vX.Y.Z` tag), matching the ahliweb/awcms
convention where the tag and Release are the same string. The already-
published `v0.25.0` Release title was corrected in place. Release-tooling
only; no runtime/product change.
