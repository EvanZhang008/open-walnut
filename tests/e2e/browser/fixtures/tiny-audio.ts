/**
 * A real, decodable MP3 as base64 — 0.25s of a 440Hz tone, mono, 32kbps.
 *
 * Committed rather than generated so the audio-letter spec needs no ffmpeg in
 * CI. It has to be genuinely decodable: the assertion that matters is that the
 * browser reads a DURATION off it, which a fake payload could never produce, and
 * which is the only way to tell "the CSP allows this media" from "the player
 * rendered and quietly refused".
 *
 * Regenerate with:
 *   ffmpeg -f lavfi -i "sine=frequency=440:duration=0.25" -ac 1 -ar 22050 \
 *     -codec:a libmp3lame -b:a 32k tiny.mp3 && base64 -i tiny.mp3 | tr -d '\n'
 */
export const TINY_MP3_BASE64 =
  'SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYyLjMuMTAwAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAASW5mbwAAAA8AAAAMAAAFnAAyMjIyMjIyMkVFRUVFRUVFWFhYWFhYWFhqampqampqamp9fX19fX19fZCQkJCQkJCQoqKioqKioqKitbW1tbW1tbXIyMjIyMjIyNra2tra2tra2u3t7e3t7e3t//////////8AAAAATGF2YzYyLjExAAAAAAAAAAAAAAAAJAM3AAAAAAAABZz23s9IAAAAAAAAAAAAAAAAAP/zQMQAFGiGcBdYGAB/5KAmOmOmOkOkWpvA7oKkLZmE5tic6nWZtSChqbuO7kYhh/H8jEYpLDuBgYGLB94gBAEMuH+jdy/hjgN/DHL+4MRACYP5MEHYDP935cPggGNKbERQwgYDAgEA//NCxAkWyXKdn5poAgAAGBJhaT9yXiWSEUWGDSEGzAS0C0xbImtSABPoyJ6JiJb+FuBagVr8kR6j1Mv8cwwxNHqPX/zIvF4xLpdS//y8SRiXS6ZF4vHf8qEgaEoSBorVFklbEkkH7xxk//NAxAkRoFZYf90AAooEFw2MBQkAQnGC4vGSY8H26omTQ3lAgNeQlPO/sar2YwVtoaqK6CM6nd/7P86vX5iyvZ+/Z+1Fnb09/97lEkvv/errRjAVAnsvqpkCgAIwCwAfN5cJrgOIiw//80LEHRSA+hhK/sRkKheaTT50VGpp/m2ez/Tp/G+jQLqHdvKjmLJvV1FVobL2vihCk48wKKnyDnWIolnL+Ldr3B3AA2VwQWRsV0CzEcx9oy7pbY6lzyRoDpoMismmUiyfURv/XR5rVXf/80DEJw24Qjm+Lvwg/4qmkjm+zj/X2bPY/u//3ifrHUywoyEssLAGicYAKAAGAbAG5xCBuEc8DhxUma30mn64rvVWXsooUpqaVd6VfJ6qdkCb+rllOnOM6sadrZSKKOKiCV40ep3KaP/zQsRLEsBOFALv9kAoJjJ+/3ceky31kql2l4TAGwCA1s8olA8IaCs2gWesCu0UW7fv9fI/+s9Q19lSG7fo9X6MX/XcqExfXU3DP2UVF+vyqt2MCKCYy5qQwCAAjAKgDk3Uw5COEBw4af/zQMRcD9hKIEzn9EBevNIZ9Uu1O2/9n2+v/x7P1NGua36U1f+2v+tkczam721+j1rZaYWAmUh1/63k8Jm3lJfLCl4TAGwCg1ksvFO6AFgrNoFnrwri6NKl7P10+FdEC3f6On9rtdfd//NCxHcQoPoYAv7EZO77Voq//5wSSRxxyQZ9wqRiAwYFZVBEwpB8w8FwaLg9EZIxfAswWBoFAYjg4dHdn8Nytf0U2WL9P6P+39f9n9uttHr7/r3My+k2NAAbZjFYtGo0OAAup2GeGgUK//NAxJAOwEog8uf0QNEISBhoBMzyjQSMw+RAAqDAkBmisYLaQMRpMIrQJX6JqmiS4ylTQ0Te/4ObQQF+HRdV0v//RAV6gurm5Grdb///TriC/2UOpNuzKZ2Gv////YZDLB31deMPnWn/80LEsBC4Vlh/XRACddyq0tX/////92JyHKGH6GfjE9ytoKlRv5QoJyYZODVVhASXxZ4xkMoC+TGzAs3LXuYGm5oGa3iPRaZAEwaCkvkAydUjcFdrXYdTAUAIGTKxEKkWLImtvPLylKX/80DEySNZpn29m8gAtqs7FCydBoOA0HfrOiUNQaUHf/yyTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv/zQsSWE+jpzAPYSACqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==';
