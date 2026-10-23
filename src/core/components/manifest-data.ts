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
      "version": "0.34.5-1",
      "tag": "component-images-0.34.5-1",
      "entry": "node_modules/sharp/lib/index.js",
      "packages": {
        "sharp": "0.34.5",
        "@img/colour": "1.0.0",
        "detect-libc": "2.1.2",
        "semver": "7.7.4"
      },
      "platforms": {
        "darwin-arm64": {
          "asset": "walnut-images-0.34.5-1-darwin-arm64.tar.gz",
          "size": 7546640,
          "tarSize": 16786944,
          "tarSha256": "8c02f738e85725f7853942608300918db11b84541b97eb5e0b92c6f88d190e5b"
        },
        "darwin-x64": {
          "asset": "walnut-images-0.34.5-1-darwin-x64.tar.gz",
          "size": 8286566,
          "tarSize": 18683392,
          "tarSha256": "e01d1cea601e5fb1d6887dccac154b2a3cb890e530df1e87e050040b4058167a"
        },
        "linux-arm64": {
          "asset": "walnut-images-0.34.5-1-linux-arm64.tar.gz",
          "size": 7673706,
          "tarSize": 17794560,
          "tarSha256": "1ab205f0e5b9c743d52f8baebdcca0da0f5c9cb4a98f564bb4c4fe670adad27e"
        },
        "linux-arm64-musl": {
          "asset": "walnut-images-0.34.5-1-linux-arm64-musl.tar.gz",
          "size": 7771886,
          "tarSize": 17761792,
          "tarSha256": "484c5205438f21e9a09ee002099a8760f33ab150fca87d01ea3bc4f0d1f28d65"
        },
        "linux-x64": {
          "asset": "walnut-images-0.34.5-1-linux-x64.tar.gz",
          "size": 7604303,
          "tarSize": 17503232,
          "tarSha256": "14d590d0a26e430d7e9f6954fefe4efeebf04c5d1917f1cb966642d558700e56"
        },
        "linux-x64-musl": {
          "asset": "walnut-images-0.34.5-1-linux-x64-musl.tar.gz",
          "size": 7657814,
          "tarSize": 17697280,
          "tarSha256": "5e456d19df2e40b044a5a4a0e0b9d0756955c4deb9fc138c59189f4caa6579c3"
        }
      }
    },
    "audio-capture": {
      "version": "1.3.6-1",
      "tag": "component-audio-capture-1.3.6-1",
      "entry": "node_modules/screencapturekit-audio-capture/dist/index.js",
      "packages": {
        "screencapturekit-audio-capture": "1.3.6",
        "node-gyp-build": "4.8.4",
        "ws": "8.19.0"
      },
      "platforms": {
        "darwin-arm64": {
          "asset": "walnut-audio-capture-1.3.6-1-darwin-arm64.tar.gz",
          "size": 101424,
          "tarSize": 444416,
          "tarSha256": "bf50ec1ba6f8ef0856b6273bd6e5d976e02d7376ec86d0f1f9566f2a0ae9fe3a"
        }
      }
    }
  }
};
