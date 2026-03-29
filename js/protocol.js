// PHOTON Protocol - Handshake, sequencing, ACK/retransmit

class PhotonProtocol {
    constructor() {
        this.deviceId = Math.floor(Math.random() * 0xFFFF);
        this.peerId = null;
        this.state = 'disconnected'; // disconnected, beaconing, connected
        this.txSeqNum = 0;
        this.rxSeqNum = -1;
        this.txQueue = [];           // Messages waiting to send
        this.currentTxFrames = [];   // Frames for current message
        this.currentTxIndex = 0;
        this.pendingAck = null;      // Seq num waiting for ACK
        this.ackTimer = null;
        this.retryCount = 0;
        this.simplexMode = false;
        this.simplexLoopCount = 0;

        // Receive buffer for assembling multi-frame messages
        this.rxBuffer = {};          // seqNum -> payload

        // Mode + file size for beacon metadata
        this.localMode = 0x00;       // 0=messaging, 1=send-file, 2=receive-file
        this.localFileSize = 0;
        this.peerMode = 0x00;
        this.peerFileSize = 0;

        // Callbacks
        this.onStateChange = null;
        this.onMessageReceived = null;
        this.onStatsUpdate = null;

        // Stats
        this.stats = {
            framesSent: 0,
            framesReceived: 0,
            messagesReceived: 0,
            errors: 0,
            bytesPerSec: 0,
            lastBytesTime: Date.now(),
            lastBytesCount: 0
        };
    }

    // Process a decoded frame from the receiver
    handleReceivedFrame(frame) {
        if (!frame || !frame.valid) {
            this.stats.errors++;
            return null; // Return what encoder should display
        }

        this.stats.framesReceived++;
        const ft = PHOTON.FRAME_TYPE;

        switch (frame.frameType) {
            case ft.BEACON:
                return this._handleBeacon(frame);
            case ft.ACK_BEACON:
                return this._handleAckBeacon(frame);
            case ft.DATA:
                return this._handleData(frame);
            case ft.ACK:
                return this._handleAck(frame);
            case ft.END:
                return this._handleEnd(frame);
            default:
                return null;
        }
    }

    setMode(mode, fileSize) {
        this.localMode = mode;
        this.localFileSize = fileSize || 0;
    }

    enableSimplex() {
        this.simplexMode = true;
        this.simplexLoopCount = 0;
        this._setState('connected');
    }

    _handleBeacon(frame) {
        // Extract peer ID from payload
        if (frame.payload.length >= 2) {
            const peerId = (frame.payload[0] << 8) | frame.payload[1];

            // Parse extended metadata if present
            if (frame.payload.length >= 6) {
                this.peerMode = frame.payload[2];
                this.peerFileSize = (frame.payload[3] << 16) | (frame.payload[4] << 8) | frame.payload[5];
            }

            if (this.state === 'disconnected' || this.state === 'beaconing') {
                this.peerId = peerId;
                this._setState('connected');

                // Respond with ACK_BEACON containing our ID + their ID + mode info
                return {
                    type: 'send',
                    frameType: PHOTON.FRAME_TYPE.ACK_BEACON,
                    seqNum: 0,
                    payload: new Uint8Array([
                        (this.deviceId >> 8) & 0xFF, this.deviceId & 0xFF,
                        (peerId >> 8) & 0xFF, peerId & 0xFF
                    ])
                };
            }
        }
        return null;
    }

    _handleAckBeacon(frame) {
        if (frame.payload.length >= 4) {
            const theirId = (frame.payload[0] << 8) | frame.payload[1];
            const ackedId = (frame.payload[2] << 8) | frame.payload[3];

            if (ackedId === this.deviceId) {
                this.peerId = theirId;
                this._setState('connected');
            }
        }
        return null;
    }

    _handleData(frame) {
        // Send ACK
        const ackAction = {
            type: 'ack',
            frameType: PHOTON.FRAME_TYPE.ACK,
            seqNum: frame.seqNum,
            payload: new Uint8Array([frame.seqNum])
        };

        // Buffer the data
        this.rxBuffer[frame.seqNum] = frame.payload;

        this._updateBps(frame.payload.length);

        return ackAction;
    }

    _handleEnd(frame) {
        // Assemble complete message from buffer
        const endSeq = frame.seqNum; // END frame's seq = total frames sent
        let messageBytes = [];

        // Collect all buffered frames in order
        const seqNums = Object.keys(this.rxBuffer).map(Number).sort((a, b) => a - b);
        for (const seq of seqNums) {
            messageBytes.push(...this.rxBuffer[seq]);
        }

        // Clear buffer
        this.rxBuffer = {};
        this.rxSeqNum = -1;

        if (messageBytes.length > 0) {
            this.stats.messagesReceived++;
            const text = new TextDecoder().decode(new Uint8Array(messageBytes));
            if (this.onMessageReceived) {
                this.onMessageReceived(text);
            }
        }

        // ACK the END frame
        return {
            type: 'ack',
            frameType: PHOTON.FRAME_TYPE.ACK,
            seqNum: frame.seqNum,
            payload: new Uint8Array([frame.seqNum])
        };
    }

    _handleAck(frame) {
        if (frame.payload.length > 0 && frame.payload[0] === this.pendingAck) {
            // ACK received, advance to next frame
            this.pendingAck = null;
            this.retryCount = 0;
            if (this.ackTimer) {
                clearTimeout(this.ackTimer);
                this.ackTimer = null;
            }
            this.currentTxIndex++;
        }
        return null;
    }

    // Queue a text message for transmission
    queueMessage(text) {
        const bytes = new TextEncoder().encode(text);
        const chunkSize = PHOTON.BYTES_PER_FRAME;
        const frames = [];

        // Split into frame-sized chunks
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.slice(i, i + chunkSize);
            frames.push({
                frameType: PHOTON.FRAME_TYPE.DATA,
                seqNum: frames.length & 0xFF,
                payload: chunk
            });
        }

        // Add END frame
        frames.push({
            frameType: PHOTON.FRAME_TYPE.END,
            seqNum: frames.length & 0xFF,
            payload: new Uint8Array(0)
        });

        this.txQueue.push(frames);

        // Start sending if not already
        if (this.currentTxFrames.length === 0) {
            this._startNextMessage();
        }
    }

    _startNextMessage() {
        if (this.txQueue.length === 0) {
            this.currentTxFrames = [];
            this.currentTxIndex = 0;
            return;
        }
        this.currentTxFrames = this.txQueue.shift();
        this.currentTxIndex = 0;
        this.txSeqNum = 0;
    }

    // Get the next frame to display (called by the TX loop)
    getNextTxFrame() {
        // If connected and have data, send it
        if (this.state === 'connected' && this.currentTxFrames.length > 0) {
            if (this.currentTxIndex < this.currentTxFrames.length) {
                const frame = this.currentTxFrames[this.currentTxIndex];
                if (this.simplexMode) {
                    this.currentTxIndex++; // Advance immediately, no ACK wait
                } else {
                    this.pendingAck = frame.seqNum;
                }
                this.stats.framesSent++;
                this._updateBps(frame.payload ? frame.payload.length : 0);
                return frame;
            } else {
                if (this.simplexMode) {
                    this.currentTxIndex = 0;
                    this.simplexLoopCount++;
                    // Immediately serve frame 0 — no idle gap between passes
                    const loopFrame = this.currentTxFrames[this.currentTxIndex];
                    this.currentTxIndex++;
                    this.stats.framesSent++;
                    this._updateBps(loopFrame.payload ? loopFrame.payload.length : 0);
                    return loopFrame;
                } else {
                    // Message complete, start next
                    this._startNextMessage();
                    if (this.currentTxFrames.length > 0) {
                        return this.getNextTxFrame();
                    }
                }
            }
        }

        // Default: send beacon if disconnected, idle if connected
        if (this.state !== 'connected') {
            return {
                frameType: PHOTON.FRAME_TYPE.BEACON,
                seqNum: 0,
                payload: new Uint8Array([
                    (this.deviceId >> 8) & 0xFF, this.deviceId & 0xFF,
                    this.localMode,
                    (this.localFileSize >> 16) & 0xFF,
                    (this.localFileSize >> 8) & 0xFF,
                    this.localFileSize & 0xFF
                ])
            };
        }

        return null; // Nothing to send, show idle
    }

    _setState(newState) {
        const oldState = this.state;
        this.state = newState;
        if (this.onStateChange) {
            this.onStateChange(newState, oldState);
        }
    }

    _updateBps(byteCount) {
        this.stats.lastBytesCount += byteCount;
        const now = Date.now();
        const elapsed = now - this.stats.lastBytesTime;
        if (elapsed >= 1000) {
            this.stats.bytesPerSec = Math.round(this.stats.lastBytesCount * 1000 / elapsed);
            this.stats.lastBytesCount = 0;
            this.stats.lastBytesTime = now;
            if (this.onStatsUpdate) this.onStatsUpdate(this.stats);
        }
    }

    getStats() {
        return { ...this.stats };
    }
}
