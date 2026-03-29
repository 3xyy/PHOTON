// PHOTON File Transfer - Chunk files and send/receive via the optical link

class PhotonFileTransfer {
    constructor(protocol) {
        this.protocol = protocol;
        this.sending = null;
        this.receiving = null;
        this.onProgress = null;
        this.onFileReceived = null;
        this.directoryHandle = null; // File System Access API
        this._startTime = 0;
        this._lastProgressTime = 0;
        this._lastProgressBytes = 0;
    }

    // Send a file (File object from input or drag-drop)
    async sendFile(file) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const chunkSize = PHOTON.BYTES_PER_FRAME - 6;

        const nameBytes = new TextEncoder().encode(file.name.slice(0, 60));
        const meta = new Uint8Array(3 + nameBytes.length + 3);
        meta[0] = 0xF0;
        meta[1] = 0x01; // FILE_START
        meta[2] = nameBytes.length;
        meta.set(nameBytes, 3);
        meta[3 + nameBytes.length] = (bytes.length >> 16) & 0xFF;
        meta[3 + nameBytes.length + 1] = (bytes.length >> 8) & 0xFF;
        meta[3 + nameBytes.length + 2] = bytes.length & 0xFF;

        this.sending = {
            name: file.name,
            data: bytes,
            totalChunks: Math.ceil(bytes.length / chunkSize),
            chunkSize,
            sentChunks: 0
        };

        this._startTime = Date.now();
        this._lastProgressTime = Date.now();
        this._lastProgressBytes = 0;

        // Queue metadata message
        this.protocol.queueMessage(new TextDecoder().decode(meta));

        // Queue data chunks
        let sentBytes = 0;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.slice(i, i + chunkSize);
            const chunkIdx = Math.floor(i / chunkSize);
            const packet = new Uint8Array(4 + chunk.length);
            packet[0] = 0xF0;
            packet[1] = 0x02; // FILE_DATA
            packet[2] = (chunkIdx >> 8) & 0xFF;
            packet[3] = chunkIdx & 0xFF;
            packet.set(chunk, 4);

            this.protocol.queueMessage(new TextDecoder().decode(packet));
            sentBytes += chunk.length;

            if (this.onProgress) {
                this.onProgress(this._buildProgress('send', file.name, bytes.length, sentBytes));
            }
        }

        // Queue FILE_END
        const endMsg = new Uint8Array([0xF0, 0x03]);
        this.protocol.queueMessage(new TextDecoder().decode(endMsg));
    }

    handleMessage(text) {
        const bytes = new TextEncoder().encode(text);
        if (bytes.length < 2 || bytes[0] !== 0xF0) return false;

        const cmd = bytes[1];

        if (cmd === 0x01) {
            // FILE_START
            const nameLen = bytes[2];
            const name = new TextDecoder().decode(bytes.slice(3, 3 + nameLen));
            const size = (bytes[3 + nameLen] << 16) | (bytes[3 + nameLen + 1] << 8) | bytes[3 + nameLen + 2];

            this.receiving = { name, size, chunks: {}, received: 0 };
            this._startTime = Date.now();
            this._lastProgressTime = Date.now();
            this._lastProgressBytes = 0;

            if (this.onProgress) {
                this.onProgress(this._buildProgress('receive', name, size, 0));
            }
            return true;
        }

        if (cmd === 0x02 && this.receiving) {
            // FILE_DATA
            const chunkIdx = (bytes[2] << 8) | bytes[3];
            const data = bytes.slice(4);
            this.receiving.chunks[chunkIdx] = data;
            this.receiving.received += data.length;

            if (this.onProgress) {
                this.onProgress(this._buildProgress(
                    'receive', this.receiving.name, this.receiving.size, this.receiving.received
                ));
            }
            return true;
        }

        if (cmd === 0x03 && this.receiving) {
            // FILE_END - assemble and download
            this._assembleAndDownload();
            return true;
        }

        return false;
    }

    _assembleAndDownload() {
        const chunks = Object.keys(this.receiving.chunks)
            .map(Number)
            .sort((a, b) => a - b)
            .map(k => this.receiving.chunks[k]);

        const assembled = new Uint8Array(this.receiving.size);
        let offset = 0;
        for (const chunk of chunks) {
            assembled.set(chunk, offset);
            offset += chunk.length;
        }

        if (this.onFileReceived) {
            this.onFileReceived(this.receiving.name, assembled);
        }

        this._downloadFile(this.receiving.name, assembled);
        this.receiving = null;
    }

    // Build a complete frame list for one-way simplex transmission
    async buildSimplexFrames(file) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const chunkSize = PHOTON.BYTES_PER_FRAME - 6;
        const totalChunks = Math.ceil(bytes.length / chunkSize);
        const nameBytes = new TextEncoder().encode(file.name.slice(0, 50));

        const frames = [];

        // FILE_START frame: [0xF0, 0x01, nameLen, ...name, sizeHi, sizeMid, sizeLo, totalChunksHi, totalChunksLo]
        const meta = new Uint8Array(3 + nameBytes.length + 3 + 2);
        meta[0] = 0xF0;
        meta[1] = 0x01;
        meta[2] = nameBytes.length;
        meta.set(nameBytes, 3);
        const so = 3 + nameBytes.length;
        meta[so]     = (bytes.length >> 16) & 0xFF;
        meta[so + 1] = (bytes.length >> 8) & 0xFF;
        meta[so + 2] = bytes.length & 0xFF;
        meta[so + 3] = (totalChunks >> 8) & 0xFF;
        meta[so + 4] = totalChunks & 0xFF;
        frames.push({ frameType: PHOTON.FRAME_TYPE.DATA, seqNum: 0, payload: meta });

        // FILE_DATA frames: [0xF0, 0x02, chunkIdxHi, chunkIdxLo, ...data]
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.slice(i, i + chunkSize);
            const chunkIdx = Math.floor(i / chunkSize);
            const packet = new Uint8Array(4 + chunk.length);
            packet[0] = 0xF0;
            packet[1] = 0x02;
            packet[2] = (chunkIdx >> 8) & 0xFF;
            packet[3] = chunkIdx & 0xFF;
            packet.set(chunk, 4);
            frames.push({ frameType: PHOTON.FRAME_TYPE.DATA, seqNum: frames.length & 0xFF, payload: packet });
        }

        // FILE_END frame
        frames.push({ frameType: PHOTON.FRAME_TYPE.DATA, seqNum: frames.length & 0xFF, payload: new Uint8Array([0xF0, 0x03]) });

        return { frames, totalChunks, fileSize: bytes.length, fileName: file.name };
    }

    // Process a raw payload from a simplex frame (no text encoding round-trip)
    handleSimplexFrame(payload) {
        if (!payload || payload.length < 2 || payload[0] !== 0xF0) return false;
        const cmd = payload[1];

        if (cmd === 0x01) {
            // FILE_START
            const nameLen = payload[2];
            const name = new TextDecoder().decode(payload.slice(3, 3 + nameLen));
            const so = 3 + nameLen;
            const size = (payload[so] << 16) | (payload[so + 1] << 8) | payload[so + 2];
            const totalChunks = (payload.length >= so + 5) ? (payload[so + 3] << 8) | payload[so + 4] : 0;

            this.receiving = { name, size, chunks: {}, received: 0, totalChunks };
            this._startTime = Date.now();

            if (this.onProgress) {
                this.onProgress(this._buildProgress('receive', name, size, 0));
            }
            return true;
        }

        if (cmd === 0x02 && this.receiving) {
            // FILE_DATA — only store each chunk index once (dedup across loops)
            const chunkIdx = (payload[2] << 8) | payload[3];
            if (!this.receiving.chunks[chunkIdx]) {
                const data = payload.slice(4);
                this.receiving.chunks[chunkIdx] = data;
                this.receiving.received += data.length;
            }

            if (this.onProgress) {
                this.onProgress(this._buildProgress(
                    'receive', this.receiving.name, this.receiving.size, this.receiving.received
                ));
            }

            // Auto-assemble when all unique chunks received
            if (this.receiving.totalChunks > 0) {
                const receivedCount = Object.keys(this.receiving.chunks).length;
                if (receivedCount >= this.receiving.totalChunks) {
                    this._assembleAndDownload();
                }
            }
            return true;
        }

        if (cmd === 0x03 && this.receiving) {
            // FILE_END — assemble whatever we have
            this._assembleAndDownload();
            return true;
        }

        return false;
    }

    _buildProgress(type, name, total, transferred) {
        const now = Date.now();
        const elapsed = (now - this._startTime) / 1000;
        const speed = elapsed > 0 ? transferred / elapsed : 0;
        const remaining = total - transferred;
        const eta = speed > 0 ? remaining / speed : 0;
        const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;

        return {
            type, name, total,
            [type === 'send' ? 'sent' : 'received']: transferred,
            speed: Math.round(speed),
            eta: Math.round(eta),
            percent
        };
    }

    async _downloadFile(name, data) {
        if (this.directoryHandle) {
            try {
                const fileHandle = await this.directoryHandle.getFileHandle(name, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(data);
                await writable.close();
                return;
            } catch (e) {
                console.error('File System Access API save failed, falling back:', e);
            }
        }

        // Fallback: browser download
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ==================== MESSAGING PROTOCOL (0xE0) ====================

    buildMessageFrames(text) {
        const bytes = new TextEncoder().encode(text);
        const chunkSize = PHOTON.BYTES_PER_FRAME - 6;
        const totalChunks = Math.ceil(bytes.length / chunkSize);
        const ackId = Math.floor(Math.random() * 256);
        const frames = [];

        // MSG_START: [0xE0, 0x01, totalChunks_hi, totalChunks_lo, textLen_hi, textLen_lo, ackId]
        frames.push({
            frameType: PHOTON.FRAME_TYPE.DATA,
            seqNum: 0,
            payload: new Uint8Array([
                0xE0, 0x01,
                (totalChunks >> 8) & 0xFF, totalChunks & 0xFF,
                (bytes.length >> 8) & 0xFF, bytes.length & 0xFF,
                ackId
            ])
        });

        // MSG_DATA chunks: [0xE0, 0x02, chunkIdx_hi, chunkIdx_lo, ...data]
        for (let i = 0; i < totalChunks; i++) {
            const chunk = bytes.slice(i * chunkSize, (i + 1) * chunkSize);
            const frame = new Uint8Array(4 + chunk.length);
            frame[0] = 0xE0;
            frame[1] = 0x02;
            frame[2] = (i >> 8) & 0xFF;
            frame[3] = i & 0xFF;
            frame.set(chunk, 4);
            frames.push({
                frameType: PHOTON.FRAME_TYPE.DATA,
                seqNum: frames.length & 0xFF,
                payload: frame
            });
        }

        // MSG_END: [0xE0, 0x03]
        frames.push({
            frameType: PHOTON.FRAME_TYPE.DATA,
            seqNum: frames.length & 0xFF,
            payload: new Uint8Array([0xE0, 0x03])
        });

        return { frames, totalChunks, ackId };
    }

    buildAckFrames(ackId) {
        return [{
            frameType: PHOTON.FRAME_TYPE.DATA,
            seqNum: 0,
            payload: new Uint8Array([0xE0, 0x04, ackId])
        }];
    }

    handleMessageFrame(payload) {
        if (!payload || payload.length < 2 || payload[0] !== 0xE0) return null;
        const subType = payload[1];

        if (subType === 0x01) {
            // MSG_START
            if (payload.length < 7) return null;
            const totalChunks = (payload[2] << 8) | payload[3];
            const textLen = (payload[4] << 8) | payload[5];
            const ackId = payload[6];
            this.msgReceiving = { chunks: {}, totalChunks, textLen, ackId, received: 0 };
            return { type: 'msg_start', totalChunks, ackId };
        }

        if (subType === 0x02 && this.msgReceiving) {
            // MSG_DATA — dedup by chunk index
            const chunkIdx = (payload[2] << 8) | payload[3];
            if (!this.msgReceiving.chunks[chunkIdx]) {
                this.msgReceiving.chunks[chunkIdx] = payload.slice(4);
                this.msgReceiving.received++;
            }
            const received = this.msgReceiving.received;
            const total = this.msgReceiving.totalChunks;

            // Auto-assemble when all chunks received
            if (received >= total) {
                const seqNums = Object.keys(this.msgReceiving.chunks).map(Number).sort((a, b) => a - b);
                const allBytes = [];
                for (const seq of seqNums) {
                    allBytes.push(...this.msgReceiving.chunks[seq]);
                }
                const text = new TextDecoder().decode(new Uint8Array(allBytes));
                const ackId = this.msgReceiving.ackId;
                this.msgReceiving = null;
                return { type: 'msg_complete', text, ackId, received, total };
            }
            return { type: 'msg_data', received, total };
        }

        if (subType === 0x03) {
            // MSG_END — ignored, assembly is by chunk count
            return { type: 'msg_end' };
        }

        if (subType === 0x04) {
            // MSG_ACK
            if (payload.length < 3) return null;
            return { type: 'msg_ack', ackId: payload[2] };
        }

        return null;
    }

    getProgress() {
        if (this.sending) return { type: 'send', ...this.sending };
        if (this.receiving) return { type: 'receive', ...this.receiving };
        return null;
    }
}
