# Jobs Governance

## EmDash Core Vs Mini Overlay

### EmDash Core

EmDash does not define Mini's job hierarchy or organizational ladder.

### Mini Overlay

Mini adds job governance as a separate organizational layer.

Mini owns:

- job levels
- job titles
- user job assignments
- supervisor linkage
- assignment history

## Design Rule

Jobs are organizational metadata, not hidden permissions.

Role hierarchy and permission grants remain separate from job hierarchy.

## Admin Surface

The admin plugin exposes:

- job levels view
- job titles view
- user-detail job assignment panel

## Operational Notes

- Job assignments should be treated as governance context and reporting input.
- Permission elevation should not be inferred from job titles alone.

## Cross-References

- `docs/governance/auth-and-authorization.md`
- `docs/admin/operations-guide.md`
