// PHOTON Encoder - Renders data as QR codes on canvas

class PhotonEncoder {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.clockState = 0;
        this.qrVersion = PHOTON.QR_VERSION;
        this.errorLevel = PHOTON.QR_ERROR_LEVEL || 'L';
        this.moduleSize = PHOTON.QR_MODULE_SIZE;
        this.lastRendered = null;
    }

    // Update canvas size based on QR settings
    updateSize() {
        const modules = this.qrVersion * 4 + 17; // QR module count formula
        const size = modules * this.moduleSize + 20; // +20 for quiet zone
        this.canvas.width = size;
        this.canvas.height = size;
    }

    // Encode bytes to base64-safe string for QR (QR works best with alphanumeric)
    _bytesToB64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    // Render a QR code containing the given data
    renderFrame(frameType, seqNum, payload) {
        // Build packet: [frameType, seqNum, payloadLen, clock, ...payload, checksum]
        const pLen = payload ? payload.length : 0;
        const packet = new Uint8Array(4 + pLen + 1);
        packet[0] = frameType;
        packet[1] = seqNum;
        packet[2] = pLen;
        packet[3] = this.clockState; // Embed clock in data
        if (payload) packet.set(payload, 4);

        // XOR checksum
        let xor = 0;
        for (let i = 0; i < packet.length - 1; i++) xor ^= packet[i];
        packet[packet.length - 1] = xor;

        // Apply RS FEC if available
        const encoded = (typeof PHOTON_RS !== 'undefined') ? PHOTON_RS.encode(packet) : packet;

        // Convert to base64 for QR encoding
        const b64 = this._bytesToB64(encoded);

        // Generate QR code
        try {
            const qr = qrcode(this.qrVersion, this.errorLevel);
            qr.addData(b64);
            qr.make();

            const count = qr.getModuleCount();
            const size = count * this.moduleSize;
            const quiet = 10; // Quiet zone pixels

            // Resize canvas if needed
            if (this.canvas.width !== size + quiet * 2) {
                this.canvas.width = size + quiet * 2;
                this.canvas.height = size + quiet * 2;
            }

            const ctx = this.ctx;

            // White background (quiet zone)
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            // Draw modules
            for (let r = 0; r < count; r++) {
                for (let c = 0; c < count; c++) {
                    ctx.fillStyle = qr.isDark(r, c) ? '#000' : '#fff';
                    ctx.fillRect(quiet + c * this.moduleSize, quiet + r * this.moduleSize,
                        this.moduleSize, this.moduleSize);
                }
            }

            this.lastRendered = b64;
        } catch (e) {
            console.error('QR encode failed:', e, 'data length:', b64.length);
            // Fallback: show error on canvas
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.fillStyle = '#f00';
            this.ctx.font = '12px monospace';
            this.ctx.fillText('QR OVERFLOW', 10, 30);
        }
    }

    toggleClock() {
        this.clockState = 1 - this.clockState;
    }

    renderBeacon(deviceId) {
        const payload = new Uint8Array(2);
        payload[0] = (deviceId >> 8) & 0xFF;
        payload[1] = deviceId & 0xFF;
        this.renderFrame(PHOTON.FRAME_TYPE.BEACON, 0, payload);
    }

    renderIdle() {
        // Show a subtle idle QR with device info
        this.renderFrame(PHOTON.FRAME_TYPE.IDLE, 0, new Uint8Array(0));
    }

    // Get max payload capacity for current QR settings
    getCapacity() {
        const capByLevel = {
            L: { 1:17, 2:32, 3:53, 4:78, 5:106, 6:134, 7:154, 8:192, 9:230, 10:271, 15:520, 20:858 },
            M: { 1:14, 2:26, 3:42, 4:62, 5:84, 6:106, 7:122, 8:152, 9:180, 10:213, 15:412, 20:666 },
            Q: { 1:11, 2:20, 3:32, 4:46, 5:60, 6:74, 7:86, 8:108, 9:130, 10:151, 15:289, 20:482 },
            H: { 1:7,  2:14, 3:24, 4:34, 5:44, 6:58, 7:64, 8:84,  9:98,  10:119, 15:227, 20:382 }
        };
        const caps = capByLevel[this.errorLevel] || capByLevel['L'];
        const rawCapacity = caps[this.qrVersion] || 134;
        const overhead = 5 + 8 + 1;
        const b64Capacity = Math.floor(rawCapacity * 3 / 4);
        return Math.max(1, b64Capacity - overhead);
    }
}
