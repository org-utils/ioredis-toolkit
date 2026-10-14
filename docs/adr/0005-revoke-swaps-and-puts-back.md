# Revoke swaps and puts back, rather than compare-and-set

`revoke()` writes the revoked record unconditionally, so that concurrent touches cannot hold a revocation off. But rotation can consume the session between `revoke()`'s read and its write, and the write then overwrote the consumed tombstone. That erased the replay signal and the forward link, and left the successor active (#83).

We kept the write unconditional. A script now writes the revoked record and returns the value it replaced, together with that value's remaining TTL, in one step. If the replaced value was not the active session `revoke()` read (it was consumed, already revoked, or unreadable), `revoke()` puts it back. The put-back is a compare-and-set that only ever replaces a revocation's write. If the replaced value was consumed, `revoke()` first walks on along its link and ends the successor, and puts the value back only after that. A revocation cut short between the two, by a crash or an error, then leaves the logout done and only the replay signal lost, not the other way round. Separately, when a link leads to a successor that does not exist yet, `revoke()` writes a revoked tombstone at the successor's key, only if the key is absent. A rotation still creating that successor then fails, rather than leaving it active.

## Considered Options

- **Compare-and-set the revocation through `change()`**, and walk on when the record has turned out consumed. Rejected: a revocation that loses 32 races in a row would fail. That gives up the guarantee that concurrent writers cannot hold a revocation off, which the `contended session writes` test holds the package to.

## Consequences

- **A brief wrong status:** between the swap and the put-back, a validation of the consumed session reads it as `revoked`. Both statuses deny, so no access is granted. Only the reported reason is wrong, for that moment.
- **A second revocation in that window:** it reads the record as `revoked` and returns before the successor has been ended. The first revocation still ends it.
- **A put-back that never happens:** if the process dies between the swap and the put-back, the consumed record stays `revoked`, and its replay signal and link are lost until its tombstone expires. The logout itself has been done by then.
- **Two revocations at once:** if both overwrite the same consumed record, each puts back only over a revocation's write. They converge on the one value no revocation wrote.
- **A rotation can now fail because of a revocation:** a rotation that loses its successor's place to a revocation throws `SessionRotationError`, with its predecessor consumed. That is the outcome the logout asked for.
- **Leftover tombstone:** if successor creation had simply failed, `revoke()` leaves a revoked tombstone where the successor would have been. It lives no longer than the predecessor's, and no credential that was ever issued names it.
