# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PHOTON (Permissionless High-bandwidth Optical Transmission Over Networks) is a pure browser-based optical communication protocol. It transmits data by displaying animated QR codes on one screen and scanning them with another device's camera. No network, Bluetooth, or server required.

## Running / Development

No build step. Open `index.html` directly in a browser (Chrome/Edge recommended for camera + File System Access API support). The entire app is vanilla HTML/CSS/JS.

To test locally, serve via a simple HTTP server (required for camera API):
```
python -m http.server 8080
# or
npx serve .
```
Then open `http://localhost:8080`.

## Architecture

### Layer Stack (bottom to top)

| Layer | File | Responsibility |
|-------|------|---------------|
| Physical | `js/physical.js` → `PhotonCamera` | Camera capture, jsQR scanning, debug overlay |
| FEC | `js/fec.js` → `GaloisField`, `ReedSolomon` | Reed-Solomon GF(256), 8 ECC bytes (`PHOTON_RS`) |
| Encoder | `js/encoder.js` → `PhotonEncoder` | Converts frame bytes → base64 → QR → canvas |
| Decoder | `js/decoder.js` → `PhotonDecoder` | QR string → base64 → RS decode → frame struct |
| Protocol | `js/protocol.js` → `PhotonProtocol` | State machine, handshake, ACK/retransmit, TX queue |
| File Transfer | `js/file-transfer.js` → `PhotonFileTransfer` | Chunking, assembly, File System Access API download |
| DTN | `js/dtn.js` → `PhotonDTN` | Simulated interplanetary delays (Moon/Mars/Jupiter) |
| App | `js/app.js` → `PhotonApp` | UI wizard, TX/RX intervals, stats DOM updates |
| Config | `js/config.js` → `PHOTON` | Global constants, `BYTES_PER_FRAME` calculation |

### Packet Format

```
[frameType, seqNum, payloadLen, clockToggle, ...payload, xor_checksum] + 8 RS ECC bytes
→ base64 encoded → stored in QR code
```

- `clockToggle` alternates 0/1 each frame so decoder can detect new frames even if QR content repeats
- Decoder deduplicates by b64 string (ignores same-frame re-scans)

### Frame Types (`PHOTON.FRAME_TYPE`)

| Hex | Name | Direction |
|-----|------|-----------|
| 0x00 | IDLE | TX→RX |
| 0x01 | BEACON | TX→RX (during handshake) |
| 0x02 | ACK_BEACON | RX→TX (completes handshake) |
| 0x03 | DATA | TX→RX |
| 0x04 | ACK | RX→TX |
| 0x05 | END | TX→RX (signals message complete) |

### File Transfer Protocol (within DATA payload)

- Payload magic byte `0xF0` signals a file protocol message
- `0xF0 0x01` = FILE_START: `[0xF0, 0x01, nameLen, ...nameBytes, sizeHi, sizeMid, sizeLo]`
- `0xF0 0x02` = FILE_DATA: `[0xF0, 0x02, chunkIdxHi, chunkIdxLo, ...chunkData]`
- `0xF0 0x03` = FILE_END: `[0xF0, 0x03]`

### UI Wizard States

Three screens controlled by `wizardStep`: `'mode'` → `'calibrate'` → `'session'`

- **mode** (`#step-mode`): Card selection for operating mode
- **calibrate** (`#step-calibrate`): Setup with large QR (left, `flex:1`, white bg) + sidebar (260px right)
- **session** (`#step-session`): Active session with same layout

### QR Auto-Sizing Rule (CRITICAL)

**QR code MUST always be maximized.** The QR canvas is in a `flex:1` container. Module size is computed as:
```javascript
const modules = qrVersion * 4 + 17;
const moduleSize = Math.floor(maxDim / (modules + 3));
```
All other UI (camera, progress, controls, stats) goes in the right sidebar (260px fixed). Never shrink the QR area.

### Session Modes

`sessionMode` values: `'send-file'`, `'receive-file'`, `'messaging'`, `'simplex-send'`, `'simplex-receive'`

- **Bidirectional modes** (send-file, receive-file, messaging): Require handshake (BEACON ↔ ACK_BEACON), use ACKs for reliable delivery
- **Simplex modes** (simplex-send, simplex-receive): No handshake. Sender loops through all chunks indefinitely. Receiver auto-assembles when chunk count matches `totalChunks` from FILE_START.

### Simplex Mode Details

For simplex, `protocol.enableSimplex()` sets `state='connected'` immediately and enables `simplexMode=true`. In `getNextTxFrame()`, simplex advances `currentTxIndex` immediately (no ACK wait) and loops back to 0 when all frames sent, incrementing `simplexLoopCount`.

`file-transfer.js` method `buildSimplexFrames(file)` pre-builds the complete frame list (FILE_START with `totalChunks` appended, all FILE_DATA frames, FILE_END). The receiver's `handleMessage()` auto-assembles when `Object.keys(chunks).length >= totalChunks`.

## Key Libraries (vendored in `lib/`)

- `qrcode-generator.js` — QR generation: `qrcode(version, errorLevel).addData(str).make()`
- `jsQR.js` — QR scanning: `jsQR(imageData, width, height)` returns `{ data: string }` or null

## QR Capacity Calculation

Effective bytes per frame depends on QR version and error level:
```javascript
rawCap = capByLevel[errorLevel][qrVersion]  // from lookup table in config.js
b64Cap = Math.floor(rawCap * 3 / 4)        // base64 expands by 4/3
BYTES_PER_FRAME = b64Cap - 5 - 8 - 1      // subtract header(4) + checksum(1) + RS ECC(8)
```

Default: v6/L = 134 raw → 100 bytes/frame → ~250 B/s at 2.5fps.
