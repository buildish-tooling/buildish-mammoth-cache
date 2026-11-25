---
title: Streaming Protocol Conformance Vectors
weight: 18
description: Normative canonical-byte, digest, empty/Unicode/PAX and ordered-conflict vectors for the draft worker protocol.
---

<!--
Copyright 2026 The Buildish Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

## Status and use

These **normative draft vectors** accompany the [worker wire contract](../cache-protocol/).
They fix expected bytes and hashes independently of an implementation's round trip.
Later conformance-test comments must cite `docs/dev/cache-protocol-vectors.md` and
the relevant heading so changed fixtures remain tied to this contract.
They do not demonstrate that a production TAR parser, SDK adapter or lifecycle has
passed qualification. Changes to the contract must update/review these vectors too.
Later conformance tests must compare both encoder and independently structured
reader/projection output against these fixed answers, not merely with each other.

All JSON tuples below use the contract's canonical `J`. UTF-8 code fences contain
literal scalar values; no normalization or ASCII escaping of Unicode is implied.
A control body's exact bytes are its tuple's UTF-8 text plus one LF (`0a`), without
the documentation wrapper or code-fence markers. Hex fields describe exact bytes.
TAR physical encoders can choose different valid numeric-header padding; these
vectors fix the complete effective application trace, not a unique compressed
artifact or an invented transport digest.

## Canonical scalar bytes

This tuple includes U+00E9, LF, quote, backslash and U+0001. The LF in the tuple is
encoded as six ASCII bytes `\u000a`; it is not the final record delimiter.

```text
["scalar","é\u000a\"\\\u0001",0,null]
```

Body including final LF, hex:

```text
5b227363616c6172222c22c3a95c75303030615c225c5c5c7530303031222c302c6e756c6c5d0a
```

Raw SHA-256 of that body: `617ee6cbadeae76300d1e0efddc0bb8a7e657cdfb3e5dbca4ff30cab53d2c579`.

## Shared model and identity

The exact model and family projection are:

```text
["model",1,"maven",[".mammoth/**"],[["data",["repository/**"],[".mammoth/**"],"aggregate",null,"default",0],["metadata",["metadata/**"],[".mammoth/**"],"single-writer","A","default",0]]]
["family",1,"vectors-",1,"e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","worker-tar-v2","native-metadata-v2","generation-v3","local-v2","path-policy-v1","unit-policy-v1","glob-policy-v1"]
```

Model ID: `e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c`.

Family ID: `mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127`.

Context is `["github","example/repo","ci","42","A",1,"rev-1","maven"]`.
The namespace is `vectors-`, configured cache schema is 1, and expected model/family
are supplied independently when validating the trace. No local source paths or
native identities participate.

## W1: empty file, Unicode/PAX file and empty channels

W1 contains a complete direct Maven unit at `repository/g`: file `a` is empty;
the second filename is exactly 51 consecutive U+00E9 scalars followed by `.jar`.
Its body is `616263` (`abc`). The usage channel and authorized metadata snapshot
are empty except for their explicit roots. The Unicode component is 106 UTF-8 bytes,
so USTAR cannot fit it in the 100-byte final name field; local PAX is required.
Native source time `1700000000123.875` milliseconds normalizes to
`1700000000123` (the source stability check retains its own full native precision).

### Effective headers and file hashes

| Ordinal | Body SHA-256                                                       |
| ------- | ------------------------------------------------------------------ |
| 1       | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 2       | `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |

The effective headers below enter both channel/archive event accumulators. Worker
v2 has no standalone header SHA or extra file-meta field.

```text
["header",0,"repository/g/a","file",0,420,0]
["header",0,"repository/g/ééééééééééééééééééééééééééééééééééééééééééééééééééé.jar","file",3,420,1700000000123]
```

### Exact local PAX body

For file ordinal 2, emit one local PAX extension named `PaxHeaders/2`, with the
following exact body. Its regular header can use ASCII fallback name `PaxFile/2`,
size 3 and integral mtime 1700000000; the admitted local path/mtime override those
effective values. Header checksum and zero padding follow the TAR profile. Neither
PAX entry contributes an application event or a managed-directory child.

PAX body byte length: `171`. Raw body hex:

```text
31343720706174683d7061796c6f61642f6167677265676174652f7265706f7369746f72792f672fc3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a9c3a92e6a61720a3234206d74696d653d313730303030303030302e3132330a
```

PAX body represented as a canonical JSON string (the decoded bytes, without a JSON LF, are the raw PAX body):

```text
"147 path=payload/aggregate/repository/g/ééééééééééééééééééééééééééééééééééééééééééééééééééé.jar\u000a24 mtime=1700000000.123\u000a"
```

### Unit projections

The exact `unit-semantic` input tuples, in order, are:

```text
["unit","maven-directory","repository/g","direct"]
["file","repository/g/a","data",0,420,0,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]
["file","repository/g/ééééééééééééééééééééééééééééééééééééééééééééééééééé.jar","data",3,420,1700000000123,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]
["unit-end","maven-directory","repository/g"]
```

The exact `unit-compare` input tuples are:

```text
["unit","maven-directory"]
["file","a",0,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]
["file","ééééééééééééééééééééééééééééééééééééééééééééééééééé.jar",3,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]
```

Unit semantic SHA-256: `8fc2527ce60214bf21861aa120aa3f5b680da7576c1fa6fd8c1c799079940467`.

Unit comparison SHA-256: `b133a1fe7444c45a6546f31fd3c6baf124ad702b3ca85d37c687535435fbb169`.

### Complete application trace

Documentation wrappers have these meanings: `["identity",tuple]` is the fixed
identity member, `["control",sequence,tuple]` is its numbered control, directory
wraps one effective directory header, `["file",ordinal,header,bodyHex]` is a regular
payload, and `["complete",tuple]` is the fixed final member. Each file is followed
by its required file-meta control; each directory header is followed by dir-open.
No wrapper bytes enter event digests. After complete, require the TAR ends and
clean single-member gzip end, as specified by the wire contract.

```text
["identity",["identity",1,"worker-tar-v2","gzip",["github","example/repo","ci","42","A",1,"rev-1","maven"],"e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127",["metadata"]]]
["control",1,["channel-open",0,"aggregate",null]]
["directory",["header",0,"","directory",0,493,0]]
["control",2,["dir-open",0,""]]
["directory",["header",0,"repository","directory",0,493,0]]
["control",3,["dir-open",0,"repository"]]
["directory",["header",0,"repository/g","directory",0,493,0]]
["control",4,["dir-open",0,"repository/g"]]
["control",5,["unit-open",0,"maven-directory","repository/g","direct"]]
["file",1,["header",0,"repository/g/a","file",0,420,0],""]
["control",6,["file-meta",0,1,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","data"]]
["file",2,["header",0,"repository/g/ééééééééééééééééééééééééééééééééééééééééééééééééééé.jar","file",3,420,1700000000123],"616263"]
["control",7,["file-meta",0,2,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","data"]]
["control",8,["unit-close",0,"maven-directory","repository/g",[2,0,1,0,3],"8fc2527ce60214bf21861aa120aa3f5b680da7576c1fa6fd8c1c799079940467","b133a1fe7444c45a6546f31fd3c6baf124ad702b3ca85d37c687535435fbb169"]]
["control",9,["dir-close",0,"repository/g"]]
["control",10,["dir-close",0,"repository"]]
["control",11,["dir-close",0,""]]
["control",12,["channel-close",0,[2,3,1,0,3],"7ef7f5566a5d956bf8fe0df6209b1f89b40f4c40b70f36167907c8bd27641029"]]
["control",13,["channel-open",1,"usage",null]]
["control",14,["dir-open",1,""]]
["control",15,["dir-close",1,""]]
["control",16,["channel-close",1,[0,1,0,0,0],"215cb7b9bfd211b0897b1a79f7e04ea8fd346e3b06a213c3e54e5332dd93568b"]]
["control",17,["channel-open",2,"snapshot","metadata"]]
["directory",["header",2,"","directory",0,493,0]]
["control",18,["dir-open",2,""]]
["control",19,["dir-close",2,""]]
["control",20,["channel-close",2,[0,1,0,0,0],"6960e472161ba0ff6c10644640b2c35bf61c5c7935bd83cd2a24d979925f5d20"]]
["complete",["complete",1,20,2,[2,5,1,0,3],[[0,"aggregate",null,[2,3,1,0,3],"7ef7f5566a5d956bf8fe0df6209b1f89b40f4c40b70f36167907c8bd27641029"],[1,"usage",null,[0,1,0,0,0],"215cb7b9bfd211b0897b1a79f7e04ea8fd346e3b06a213c3e54e5332dd93568b"],[2,"snapshot","metadata",[0,1,0,0,0],"6960e472161ba0ff6c10644640b2c35bf61c5c7935bd83cd2a24d979925f5d20"]],"1ea9434a00347f8d8bf1f0128a9bfa0e9d9ffb9d3383e583379213135056ac73"]]
```

### Expected channel and final values

| Channel       | Counts        | Event SHA-256                                                      |
| ------------- | ------------- | ------------------------------------------------------------------ |
| 0 (aggregate) | `[2,3,1,0,3]` | `7ef7f5566a5d956bf8fe0df6209b1f89b40f4c40b70f36167907c8bd27641029` |
| 1 (usage)     | `[0,1,0,0,0]` | `215cb7b9bfd211b0897b1a79f7e04ea8fd346e3b06a213c3e54e5332dd93568b` |
| 2 (snapshot)  | `[0,1,0,0,0]` | `6960e472161ba0ff6c10644640b2c35bf61c5c7935bd83cd2a24d979925f5d20` |

Total counts: `[2,5,1,0,3]`; last control sequence: `20`; last payload ordinal: `2`.

Final worker-events SHA-256: `1ea9434a00347f8d8bf1f0128a9bfa0e9d9ffb9d3383e583379213135056ac73`.

Raw SHA-256 of canonical complete body including LF: `799eb0e4dab2f48a5e7ae12e77dd1a145eb8c7b7eb21677bab502dfa80e8d185`.

## W0: no payload files and no contributed snapshot

Use the same expected context/model/family, with snapshotPartitions empty. This
pins zero-payload ordinal handling, required empty roots/channel seals and no
implicit snapshot channel. Per the contract, a configured but uncontributed snapshot
is not invented by the decoder; caller-side required/optional writer policy still
applies. The complete effective trace is:

```text
["identity",["identity",1,"worker-tar-v2","gzip",["github","example/repo","ci","42","A",1,"rev-1","maven"],"e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127",[]]]
["control",1,["channel-open",0,"aggregate",null]]
["directory",["header",0,"","directory",0,493,0]]
["control",2,["dir-open",0,""]]
["control",3,["dir-close",0,""]]
["control",4,["channel-close",0,[0,1,0,0,0],"677790bf6b15798f7e27668a6b97714c330fef67c01d1f8cc20141f6c379fe0f"]]
["control",5,["channel-open",1,"usage",null]]
["control",6,["dir-open",1,""]]
["control",7,["dir-close",1,""]]
["control",8,["channel-close",1,[0,1,0,0,0],"215cb7b9bfd211b0897b1a79f7e04ea8fd346e3b06a213c3e54e5332dd93568b"]]
["complete",["complete",1,8,0,[0,2,0,0,0],[[0,"aggregate",null,[0,1,0,0,0],"677790bf6b15798f7e27668a6b97714c330fef67c01d1f8cc20141f6c379fe0f"],[1,"usage",null,[0,1,0,0,0],"215cb7b9bfd211b0897b1a79f7e04ea8fd346e3b06a213c3e54e5332dd93568b"]],"13063138dacc3f472efdf4011d4ca6318746c4b6389620b00338032bf3674422"]]
```

| Channel       | Counts        | Event SHA-256                                                      |
| ------------- | ------------- | ------------------------------------------------------------------ |
| 0 (aggregate) | `[0,1,0,0,0]` | `677790bf6b15798f7e27668a6b97714c330fef67c01d1f8cc20141f6c379fe0f` |
| 1 (usage)     | `[0,1,0,0,0]` | `215cb7b9bfd211b0897b1a79f7e04ea8fd346e3b06a213c3e54e5332dd93568b` |

Total counts: `[0,2,0,0,0]`; last control sequence: `8`; last payload ordinal: `0`.

Final worker-events SHA-256: `13063138dacc3f472efdf4011d4ca6318746c4b6389620b00338032bf3674422`.

Raw SHA-256 of canonical complete body including LF: `2427c933f487dd58d3136cba40ee69b6d4da90ee6b157680effccafa57693fa0`.

## Ordinary-file reduction vectors

Configuration order normalization is normative: `["A","B","A","C"]` becomes
`["A","B","C"]`, not a sorted list and not a configuration error. Optional jobs
added only for snapshot lookup do not enter this ordinary order.

Aliases X, Y and Z below name SHA-256 of one-byte bodies `78`, `79` and `7a`,
respectively. Candidate tuples are `[producer,hash,size,mtimeMs,mode]`; modes are
decimal. The expected result tuples are `["selected",producer,hash,size,mtimeMs,mode]`
or `["error",producer,reason]` at the first rejected fold step. Reason labels are
vector descriptions, not a new public error API. Input candidate listing order does
not replace the explicit ordinaryOrder field.

X = `2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881`; Y = `a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa`; Z = `594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06`.

Each following row is `[name,duplicatePolicy,ordinaryOrder,candidates,expected]`:

```text
["strict-different","strict",["A","B","C"],[["A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,420],["B","a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa",1,20,420],["C","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,30,420]],["error","B","different-content"]]
["tie-before-newer","newer-mtime",["A","B","C"],[["A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,420],["B","a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa",1,10,420],["C","594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06",1,20,420]],["error","B","different-content-equal-time"]]
["newer-first","newer-mtime",["C","A","B"],[["A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,420],["B","a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa",1,10,420],["C","594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06",1,20,420]],["selected","C","594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06",1,20,420]]
["equivalent-union","strict",["A","B","C"],[["A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,420],["B","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,493],["C","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,20,420]],["selected","C","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,20,493]]
["equivalent-time-tie","strict",["A","B"],[["A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,420],["B","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,493]],["selected","A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,493]]
["mode-does-not-resurrect","newer-mtime",["A","B","C"],[["A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,10,493],["B","a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa",1,20,420],["C","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,30,420]],["selected","C","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,30,420]]
["older-difference","newer-mtime",["A","B"],[["A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,20,493],["B","a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa",1,10,420]],["selected","A","2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",1,20,493]]
```

The A/B same-time different-content failure stays rejected despite C's newer
payload. With C first, the same candidates can succeed, matching configured-order
folding. Equivalent-time ties keep the earlier producer; equivalent content unions
executable bits. The mode-resurrection case must end at 0644, not 0755: earlier X
bits were discarded when Y replaced that accumulator, and cannot be unioned back
against final X. Always selecting C and comparing everything only against C would
get rejection or mode handling wrong.

## Invalid framing and binding vectors

Pairing/hash/control/fold vectors fix the application contract. Raw TAR/PAX/gzip
rejection cases below target the **current candidate physical profile**; their exact
necessity and enforcement remain under the [parser investigation](../cache-protocol/#parser-enforcement-interface-and-dependency-gate).
They do not independently select a parser extension. A reviewed physical-profile
change must update those cases explicitly, preserving required integrity and memory
invariants; an existing parser's permissive success alone is not such a decision.

Apply each mutation independently; none may produce an accepted contribution or
live installation. An invalid operation may fail early; all accepted losing inputs
must still have complete body/hash/seal verification.

| Input/mutation                                                                      | Required rejection point                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| W1 omit control 6 (file 1 metadata), deliver the next file header                   | Metadata-required state, before accepting/advancing the pending file.               |
| W1 control 6 has ordinal 2 or file 2's contentSha                                   | Exact pairing/binding check.                                                        |
| W1 use worker-tar-v2 identity or six-field file-meta                                | Profile/tuple arity admission rejects before a valid contribution.                  |
| W1 change a valid header time, preserve stale channel/archive seals                 | Header remains bound in both accumulators even without standalone header SHA.       |
| W1 replace body `616263` with `616264`, retain file-meta                            | Body hash mismatch immediately at its metadata, even when that file loses.          |
| W1 mutate unit count/bodyBytes or final eventSha                                    | Unit or final seal check; provisional staging does not authorize installation.      |
| Canonical scalar uses `\n`, whitespace, ASCII escape for U+00E9 or missing final LF | Noncanonical control encoding/framing, even if generic JSON decodes the same value. |
| Local PAX raw header declares size 65,537; no extension body supplied               | Raw-header admission, before extension body allocation/accumulation.                |
| Two local PAX headers, a global PAX header, or a PAX header before a control        | Strict type/order/provenance check before normalized entry acceptance.              |
| PAX record `11 path=one\n`                                                          | Length/framing mismatch; never partial object success.                              |
| Nonzero padding or missing two TAR end blocks                                       | Raw parser framing check.                                                           |
| Two valid gzip members concatenated                                                 | First-member boundary/trailing-input check; permissive gunzip EOF is insufficient.  |

Duplicate-PAX-key raw body, hex (two individually valid `path` records):

```text
313220706174683d6f6e650a313220706174683d74776f0a
```

Reject at the second raw key, before overwriting a normalized object property. The
same body represented as a canonical JSON string is:

```text
"12 path=one\u000a12 path=two\u000a"
```

These vectors require the raw parser interface described in the parent document;
stock normalized entry callbacks do not qualify. Parser proof must additionally
exercise split headers/lengths/UTF-8, over-limit queued chunks and bounded multi-reader
backpressure. Normative answers are documentation fixtures, not production parser
or full lifecycle test results.

## N0: raw worker artifact naming

Use the active Maven model/family and context above. The original genuine survivor
index has observation Q SHA of64 `a` characters; selected snapshot IDs are
`["metadata"]`. This is an identity projection vector, not permission to construct
an owner from a hash. SHA-256/U64BE framing independently gives:

```text
producerSha = 7bc0bf858d916f802423c244043963037a23be107d90ccbebeeed37f091cebb5
decisionSha = fdf7860d24ea9a9c72d24be05abf152c1a5c23db8e4a88dbb24bf23fd7031692
name = mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127-w7bc0bf858d916f802423c244043963037a23be107d90ccbebeeed37f091cebb5-a1-dfdf7860d24ea9a9c72d24be05abf152c1a5c23db8e4a88dbb24bf23fd7031692.tar.gz
```

Changing runAttempt changes its decimal name segment, not producerSha. A different
observation or snapshot selection changes decisionSha. The actual outgoing function
requires the genuine completed GC owner and exact context before reading these facts.
Compressed package/download/read SHA and strict full worker validation remain separate.

## P0: frozen purge configuration

Canonical model (no LF in the framed model digest):

```text
["model",1,"maven",[".mammoth/**"],[["data",["data/**"],[".mammoth/**"],"aggregate",null,"default",0,["data/*.tmp"]]]]
```

Model ID: `1af7f00459531ee214786c73d330bf6155a771fa44297d239853b8e46259b85f`. The final nonempty purge list is part of the existing model
identity; omission represents no purging. Preserve-only exclusions remain distinct,
even when the upload exclusion union would be identical. No separate policy Q exists.

## A0: CI invocation anchor

Each code line below has one terminal LF. The hash covers those exact UTF-8 bytes,
including LF; it is a raw SHA-256, not a new framed protocol digest.

### enabled

```text
["streaming-lifecycle",1,"/cache",["native",1,"directory","1","3","0",16877,"-1","0","1",null],["github","example/repo","ci","42","A",1,"rev-1","maven"],"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
```

Raw SHA-256: `71b4a91ebd2bc25b9402db6a20261c0836733763a5f5c3bd2e57bbe0e155fd47`.

### disabled

```text
["streaming-disabled",1,["github","example/repo","ci","42","A",1,"rev-1","maven"],"/cache","/temp"]
```

Raw SHA-256: `26bce7753dbeb3164291194e24c642c72f839690788f179bc18776dcd904b5a0`.

## G0: operational Gradle records

Canonical records include terminal LF; raw digests include it. Registration filenames
use the existing framed `H("gradle-installation",record)` over J without LF. The tab in
the registration path must use `\u0009`, never the JSON short escape `\t`.

### registration

```text
["gradle-installation",1,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","/tools/Gradle é\u0009control","9.9.2","/cache home","/tools/jdk"]
```

Raw SHA-256: `fbf883852ee898196dceb36357600f5c247e8875d6f191a339b00b524dcd614b`.
Filename: `645b0dc68cf6e7ef04073bb864fd688d2245aacdeecbcf71fb1d492dcba9cc0c.json`.

### failure

```text
["gradle-capture-failed",1,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
```

Raw SHA-256: `449e1a83deaf1cb2cf57051f9a81aa2fa9a6b08ce0356fc85dda5a32fa1c45b8`.

## Generic local directory insertion

The new local install-unit descriptor uses the existing canonical record encoding;
this does not change worker archive framing. Its exact UTF-8 bytes are the following
ASCII JSON followed by one LF (no spaces):

```json
["install-unit-open", "directory", "repository/new", "subtree"]
```

SHA-256 of those bytes including LF:
`6cb4d1c444a391b9be44b31e9f7ff1291742c02f78d3192a53d41b5a9c120a25`.
The matching close is `["install-unit-close","directory","repository/new"]` plus LF.
These are record fragments, not a valid empty unit: exactly one matching directory
insert and its full source evidence are mandatory, as specified in the
[local install contract](../cache-lifecycle-protocol/#install-batches-and-recovery).

## M2: metadata-only base and local pin

These vectors describe the active incompatible metadata reader/writer/handoff cut.
Worker TAR grammar remains v2; generation-v3 and explicit partition seed eligibility
change the family and all family-derived identities. Model/prefix/schema are
the existing Maven model vector, `vectors-`, and 1.

Family:

```text
mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127
```

Exact descriptor (canonical UTF-8 JSON plus one LF), followed by its object-ref:

```text
["base-object",2,"native-metadata-v2",["mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","data","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]]
["object-ref",["mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","data","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-w-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-p-data-d-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",400,"0980b8fd4a18254ce27f8c87938c0dc73d34c68f1721f01d0818f19ffafaf0bf"]
```

The descriptor has 400 bytes. Its SHA binds this control document only, with no
payload membership/content assertions. Exact generation-v3 record (the final reserved sweep timestamp is unset):

```text
["generation",3,"generation-v3","mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",[["object","data",["object-ref",["mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","data","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-w-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-p-data-d-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",400,"0980b8fd4a18254ce27f8c87938c0dc73d34c68f1721f01d0818f19ffafaf0bf"]],["empty","metadata"]],[["data"],["metadata"]],"47ce1a4a69c841392f1f868a47d82df11c12877dcf176b0e6a8d37957ac39831","mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-g-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-d-47ce1a4a69c841392f1f868a47d82df11c12877dcf176b0e6a8d37957ac39831",null]
```

For the local Unix summary, frame the profile, then the directory and file rows
below in the `partition-native-metadata` digest domain. Root directory metadata
and directory close do not add frames. File content is not an input.

```text
["native-metadata-summary",1,"unix-mode-0777","native-mtime-ns","files-first-utf8-dfs"]
["directory","repository",493]
["file","repository/a.jar",3,"1000000000",420]
["partition-metadata",1,"5c3a86e03c9862757616c819182b753a8c2fd95b13edfc0fe78949820f22f94b",1,1,3]
```

The pin binds invocation `a` repeated 64 times and the exact admitted materialized
object before overlays. It has no file list:

```text
["pinned-partition-metadata",2,"local-v2","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","data",["object-ref",["mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","data","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-w-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-p-data-d-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",400,"0980b8fd4a18254ce27f8c87938c0dc73d34c68f1721f01d0818f19ffafaf0bf"],["native-metadata-summary",1,"unix-mode-0777","native-mtime-ns","files-first-utf8-dfs"],["partition-metadata",1,"5c3a86e03c9862757616c819182b753a8c2fd95b13edfc0fe78949820f22f94b",1,1,3]]
```

## H2: minimal successful-main handoff

This ordered data handoff has two missing partitions, no baseline generation and no
snapshot payload. Only the actual activity stream remains per file until post.
Native/index/GC authority is freshly admitted and is never encoded here. Exact
handoff framing plus its Q (each record is canonical JSON plus LF):

```text
["local-stream",1,"handoff","7ca0244a1b6d0e46ff8e799981e395ab96b10b620463b3b6071874ec46472299","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127",null]
["handoff",4,"refs/heads/main",null,null,7,"enabled",null,null,["ref","activity",".mammoth/v1/7ca0244a1b6d0e46ff8e799981e395ab96b10b620463b3b6071874ec46472299/files/activity",369,"c3ebf73de55c4ff5f83619ccb82e1a151e3ac577820871ce486462b9d0ae7a03"],1234,0,null]
["partition","data","miss",null,null]
["partition","metadata","miss",null,null]
["local-end",3,"12b4b923324f3dd853d36876b204e47f7347b75c3c5bb47ec8b9cbb2859a94a3"]
["ref","handoff",".mammoth/v1/7ca0244a1b6d0e46ff8e799981e395ab96b10b620463b3b6071874ec46472299/files/handoff",675,"6c456b1e8e6fbb3d6f6b12a1dcd133b9256a44ef42175867439efd978702100d"]
```

The activity Q names this exact empty activity stream:

```text
["local-stream",1,"activity","7ca0244a1b6d0e46ff8e799981e395ab96b10b620463b3b6071874ec46472299","e8aa85638c5a93c13d1acface8b2384e353f71f7a724115f0d143780b665f04c","mammoth-s1-maven-8b490ffd777d80d346abb010da1a4d8f6e8be8998efd56fa33a1fbda176c4127",null]
["dir-open",""]
["dir-close",""]
["local-end",2,"c30c12fd6a873cacc46a0d7d0953a2cb35c043653cfded9620290fe80f0dc0f9"]
```
