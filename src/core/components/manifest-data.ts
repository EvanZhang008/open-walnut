// Written by scripts/components/build.ts --write. Do not edit by hand.
import type { ComponentsManifest } from './types.js';

export const COMPONENTS_MANIFEST: ComponentsManifest = {
  "schema": 1,
  "repo": "EvanZhang008/open-walnut",
  "components": {
    "embedding": {
      "version": "4.2.0-1",
      "tag": "component-embedding-4.2.0-1",
      "entry": "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
      "packages": {
        "@huggingface/transformers": "4.2.0",
        "onnxruntime-node": "1.24.3",
        "onnxruntime-common": "1.24.3"
      },
      "platforms": {
        "darwin-arm64": {
          "asset": "walnut-embedding-4.2.0-1-darwin-arm64.tar.gz",
          "size": 10144816,
          "tarSize": 37655552,
          "tarSha256": "c8679eb16700e864a1f74431f2a447421d0be0a7daf609af537a054de7a4f311"
        },
        "linux-arm64": {
          "asset": "walnut-embedding-4.2.0-1-linux-arm64.tar.gz",
          "size": 7335137,
          "tarSize": 20472320,
          "tarSha256": "03a37bcf03fd79607b6d6e8b81fb6598da90fd8133300b9fabeb773e37e43f38"
        },
        "linux-x64": {
          "asset": "walnut-embedding-4.2.0-1-linux-x64.tar.gz",
          "size": 13223113,
          "tarSize": 37001216,
          "tarSha256": "777ac90dc08db6d503715f73ffed6223e0ef59b2e16d40aa251f964214e220ad"
        }
      }
    },
    "images": {
      "version": "0.35.5-1",
      "tag": "component-images-0.35.5-1",
      "entry": "node_modules/sharp/dist/index.cjs",
      "packages": {
        "sharp": "0.35.5",
        "@img/colour": "1.1.0",
        "detect-libc": "2.1.2",
        "semver": "7.8.6"
      },
      "platforms": {
        "darwin-arm64": {
          "asset": "walnut-images-0.35.5-1-darwin-arm64.tar.gz",
          "size": 8241441,
          "tarSize": 19224064,
          "tarSha256": "03a3c5ef479b3f745a6fd9ce974c540de10cf38e1200ca8047bf5aebfb372582"
        },
        "darwin-x64": {
          "asset": "walnut-images-0.35.5-1-darwin-x64.tar.gz",
          "size": 8982804,
          "tarSize": 21337088,
          "tarSha256": "a0c1372d636089d611c0e06f891a96f96e2dea28ec9d8d7dab9301bfee9029df"
        },
        "linux-arm64": {
          "asset": "walnut-images-0.35.5-1-linux-arm64.tar.gz",
          "size": 8380259,
          "tarSize": 19567104,
          "tarSha256": "d376923a4ac47362836e28bff588389612762aac44eccad65bef1fd44e834991"
        },
        "linux-arm64-musl": {
          "asset": "walnut-images-0.35.5-1-linux-arm64-musl.tar.gz",
          "size": 8379984,
          "tarSize": 19755008,
          "tarSha256": "21fc22cf4ddd6b23962e2c6256d3c5ec4e56adb853fa74690fa3546ab9bfd223"
        },
        "linux-x64": {
          "asset": "walnut-images-0.35.5-1-linux-x64.tar.gz",
          "size": 8311682,
          "tarSize": 19826688,
          "tarSha256": "e5188b68a62ea9304b0b475cdb17321e1e10f25350a1cffde49d02184070d920"
        },
        "linux-x64-musl": {
          "asset": "walnut-images-0.35.5-1-linux-x64-musl.tar.gz",
          "size": 8304827,
          "tarSize": 19924480,
          "tarSha256": "ccc7c19fa04892b61a61b295875d58d717d6aa8ed1b8bcc9c2e3973d7deca0e2"
        }
      }
    },
    "audio-capture": {
      "version": "1.3.6-2",
      "tag": "component-audio-capture-1.3.6-2",
      "entry": "node_modules/screencapturekit-audio-capture/dist/index.js",
      "packages": {
        "screencapturekit-audio-capture": "1.3.6",
        "node-gyp-build": "4.8.4",
        "ws": "8.21.0"
      },
      "platforms": {
        "darwin-arm64": {
          "asset": "walnut-audio-capture-1.3.6-2-darwin-arm64.tar.gz",
          "size": 102069,
          "tarSize": 447488,
          "tarSha256": "865bb8b32f1049ccee377e418c2b6ffd0f6a7198e5c1e408e3d0dddbfd4826cc"
        }
      }
    }
  }
};
