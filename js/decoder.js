// PHOTON Decoder - Extracts data from QR code scans

class PhotonDecoder {
    constructor() {
        this.lastData = null;      // Last decoded b64 string (for dedup)
        this.lastClockState = -1;
        this.frameCount = 0;
        this.errorCount = 0;
        this.fecCorrected = 0;
        this.simplexMode = false; // Skip clock dedup in simplex (b64 dedup is sufficient)
    }

    // Decode base64 string from QR scan into a frame
    // Returns: { frameType, seqNum, payload, valid, clockState } or null
    decodeQR(b64String) {
        if (!b64String) return null;

        // Deduplicate - skip if same QR as last time
        if (b64String === this.lastData) return null;
        this.lastData = b64String;

        try {
            // Decode base64 to bytes
            const binary = atob(b64String);
            const rawBytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                rawBytes[i] = binary.charCodeAt(i);
            }

            // Apply RS error correction if available
            let packet;
            if (typeof PHOTON_RS !== 'undefined') {
                const rsResult = PHOTON_RS.decode(rawBytes);
                if (!rsResult) {
                    this.errorCount++;
                    return null;
                }
                packet = rsResult.data;
                if (rsResult.corrected > 0) {
                    this.fecCorrected += rsResult.corrected;
                }
            } else {
                packet = rawBytes;
            }

            // Parse packet: [frameType, seqNum, payloadLen, clock, ...payload, checksum]
            if (packet.length < 5) {
                this.errorCount++;
                return null;
            }

            const frameType = packet[0];
            const seqNum = packet[1];
            const payloadLen = packet[2];
            const clockState = packet[3];

            if (4 + payloadLen + 1 > packet.length) {
                this.errorCount++;
                return null;
            }

            const payload = packet.slice(4, 4 + payloadLen);
            const receivedChecksum = packet[4 + payloadLen];

            // Verify checksum
            let xor = 0;
            for (let i = 0; i < 4 + payloadLen; i++) xor ^= packet[i];
            const valid = xor === receivedChecksum;

            if (!valid) {
                this.errorCount++;
                return null;
            }

            // Skip if same clock as last (not needed in simplex — b64 dedup is sufficient)
            if (!this.simplexMode) {
                if (clockState === this.lastClockState) return null;
            }
            this.lastClockState = clockState;

            this.frameCount++;

            return {
                frameType,
                seqNum,
                payload: new Uint8Array(payload),
                valid: true,
                clockState
            };
        } catch (e) {
            this.errorCount++;
            return null;
        }
    }

    getErrorRate() {
        if (this.frameCount === 0) return 0;
        return this.errorCount / (this.frameCount + this.errorCount);
    }

    reset() {
        this.lastData = null;
        this.lastClockState = -1;
        this.frameCount = 0;
        this.errorCount = 0;
        this.fecCorrected = 0;
    }
}
