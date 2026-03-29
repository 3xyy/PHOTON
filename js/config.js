// PHOTON Configuration
const PHOTON = {
    // QR Settings
    QR_VERSION: 6,          // QR version 6 = 41x41 modules, ~134 byte capacity
    QR_ERROR_LEVEL: 'L',    // L=7% M=15% Q=25% H=30% recovery
    QR_MODULE_SIZE: 8,      // Pixels per QR module

    // Timing
    FRAME_RATE_MS: 400,     // 2.5 fps transmit
    CAMERA_POLL_MS: 60,     // ~16 fps camera sampling
    HANDSHAKE_INTERVAL_MS: 1000,
    ACK_TIMEOUT_MS: 3000,
    MAX_RETRIES: 5,

    // Frame types
    FRAME_TYPE: {
        IDLE: 0x00,
        BEACON: 0x01,
        ACK_BEACON: 0x02,
        DATA: 0x03,
        ACK: 0x04,
        END: 0x05,
    },

    // Computed
    BYTES_PER_FRAME: 0,

    init() {
        // QR capacity by version and error correction level (bytes)
        const capByLevel = {
            L: { 1:17, 2:32, 3:53, 4:78, 5:106, 6:134, 7:154, 8:192, 9:230, 10:271, 15:520, 20:858 },
            M: { 1:14, 2:26, 3:42, 4:62, 5:84, 6:106, 7:122, 8:152, 9:180, 10:213, 15:412, 20:666 },
            Q: { 1:11, 2:20, 3:32, 4:46, 5:60, 6:74, 7:86, 8:108, 9:130, 10:151, 15:289, 20:482 },
            H: { 1:7,  2:14, 3:24, 4:34, 5:44, 6:58, 7:64, 8:84,  9:98,  10:119, 15:227, 20:382 }
        };
        const level = this.QR_ERROR_LEVEL || 'L';
        const caps = capByLevel[level] || capByLevel['L'];
        const rawCap = caps[this.QR_VERSION] || caps[6] || 134;
        const decodedCap = Math.floor(rawCap * 3 / 4);
        this.BYTES_PER_FRAME = Math.max(1, decodedCap - 5 - 8 - 1); // header + RS + checksum
        return this;
    }
}.init();
