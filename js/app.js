// PHOTON App - Main controller with wizard flow

class PhotonApp {
    constructor() {
        this.wizardStep = 'mode'; // 'mode' | 'calibrate' | 'session'
        this.sessionMode = null;  // 'send-file' | 'receive-file' | 'messaging'
        this.isPaused = false;

        // Protocol + modules (created once, reused across steps)
        this.protocol = new PhotonProtocol();
        this.decoder = new PhotonDecoder();
        this.dtn = new PhotonDTN();
        this.fileTransfer = new PhotonFileTransfer(this.protocol);

        // Encoder/camera for calibration step
        this.calEncoder = null;
        this.calCamera = null;

        // Encoder/camera for session step
        this.encoder = null;
        this.camera = null;

        // Intervals
        this.txInterval = null;
        this.rxInterval = null;

        // Action queue for ACKs
        this.lastAction = null;
        this.actionExpiry = 0;

        // File to send (selected during calibration)
        this.pendingFile = null;
        this.saveDirectoryHandle = null;

        // Screen wake lock
        this.wakeLock = null;

        // Half-duplex messaging state machine
        this.msgState = 'idle'; // idle, sending, receiving, acking
        this.msgAckId = null;   // ackId we're waiting for
        this.msgAckTimer = null;
        this.msgLastTxTime = 0; // throttle TX to FRAME_RATE_MS
        this.msgPendingDelivery = null; // element to update on delivery

        this._initWizard();
    }

    // ==================== WIZARD ====================

    _initWizard() {
        // Mode selection
        document.querySelectorAll('.mode-card').forEach(card => {
            card.addEventListener('click', () => {
                this._selectMode(card.dataset.mode);
            });
        });

        // Calibration buttons
        document.getElementById('back-to-mode-btn').addEventListener('click', () => this._goToStep('mode'));
        document.getElementById('start-session-btn').addEventListener('click', () => this._goToStep('session'));

        // Calibration settings
        document.getElementById('qr-version').addEventListener('change', () => this._applySettings());
        document.getElementById('qr-error-level').addEventListener('change', () => this._applySettings());
        document.getElementById('frame-rate').addEventListener('change', () => this._applySettings());

        // Camera select
        document.getElementById('camera-select').addEventListener('change', (e) => this._switchCamera(e.target.value));
        document.getElementById('camera-select-session').addEventListener('change', (e) => this._switchSessionCamera(e.target.value));

        // Camera mirror
        document.getElementById('camera-mirror').addEventListener('change', (e) => {
            const wrap = document.querySelector('.calibrate-camera-wrap');
            wrap.classList.toggle('mirrored', e.target.checked);
        });

        // DTN
        document.getElementById('dtn-select').addEventListener('change', (e) => {
            const preset = this.dtn.enable(e.target.value);
            const statusEl = document.getElementById('dtn-status');
            if (preset && preset.delay > 0) {
                statusEl.textContent = preset.description;
            } else {
                statusEl.textContent = '';
            }
        });

        // File select in calibration (send mode)
        const calFileDrop = document.getElementById('cal-file-drop');
        const calFileInput = document.getElementById('cal-file-input');
        if (calFileDrop && calFileInput) {
            calFileDrop.addEventListener('click', () => calFileInput.click());
            calFileDrop.addEventListener('dragover', (e) => { e.preventDefault(); calFileDrop.classList.add('dragover'); });
            calFileDrop.addEventListener('dragleave', () => calFileDrop.classList.remove('dragover'));
            calFileDrop.addEventListener('drop', (e) => {
                e.preventDefault();
                calFileDrop.classList.remove('dragover');
                if (e.dataTransfer.files.length > 0) this._setPendingFile(e.dataTransfer.files[0]);
            });
            calFileInput.addEventListener('change', () => {
                if (calFileInput.files.length > 0) this._setPendingFile(calFileInput.files[0]);
            });
        }

        // Save location (receive mode)
        document.getElementById('save-location-btn').addEventListener('click', async () => {
            if (typeof window.showDirectoryPicker === 'function') {
                try {
                    this.saveDirectoryHandle = await window.showDirectoryPicker();
                    document.getElementById('save-location-info').textContent =
                        `Saving to: ${this.saveDirectoryHandle.name}`;
                    this.fileTransfer.directoryHandle = this.saveDirectoryHandle;
                } catch (e) {
                    // User cancelled or API error
                    if (e.name !== 'AbortError') {
                        document.getElementById('save-location-info').textContent =
                            'Could not select folder. Files will download normally.';
                    }
                }
            } else {
                document.getElementById('save-location-info').textContent =
                    'Folder picker not supported in this browser. Files will download to default location.';
            }
        });

        // Session buttons
        document.getElementById('pause-btn').addEventListener('click', () => this._togglePause());
        document.getElementById('stop-btn').addEventListener('click', () => this._stopSession());
        document.getElementById('loopback-btn').addEventListener('click', () => this._runLoopback());
        document.getElementById('camera-hide-btn').addEventListener('click', () => this._toggleCameraVisibility());

        // Session settings (separate selects from calibration)
        document.getElementById('qr-version-session').addEventListener('change', () => this._applySessionSettings());
        document.getElementById('qr-error-level-session').addEventListener('change', () => this._applySessionSettings());
        document.getElementById('frame-rate-session').addEventListener('change', () => this._applySessionSettings());

        // Session file drop
        const fileDrop = document.getElementById('file-drop');
        const fileInput = document.getElementById('file-input');
        if (fileDrop && fileInput) {
            fileDrop.addEventListener('click', () => fileInput.click());
            fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('dragover'); });
            fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('dragover'));
            fileDrop.addEventListener('drop', (e) => {
                e.preventDefault();
                fileDrop.classList.remove('dragover');
                if (e.dataTransfer.files.length > 0) this._sendFile(e.dataTransfer.files[0]);
            });
            fileInput.addEventListener('change', () => {
                if (fileInput.files.length > 0) this._sendFile(fileInput.files[0]);
            });
        }

        // Chat input
        document.getElementById('send-btn').addEventListener('click', () => this._sendMessage());
        document.getElementById('msg-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._sendMessage();
            }
        });

        // Resize recalc QR size
        window.addEventListener('resize', () => {
            if (this.wizardStep === 'calibrate') this._autoSizeCalQR();
            if (this.wizardStep === 'session') this._autoSizeSessionQR();
        });

        // File transfer callbacks
        this.fileTransfer.onProgress = (p) => this._updateTransferProgress(p);
        this.fileTransfer.onFileReceived = (name, data) => {
            if (this.sessionMode === 'simplex-receive') {
                // Update the simplex RX panel
                const statusEl = document.getElementById('simplex-rx-status-text');
                if (statusEl) statusEl.textContent = 'COMPLETE!';
                const iconEl = document.getElementById('simplex-rx-icon');
                if (iconEl) iconEl.textContent = '\u2705';
                const fileEl = document.getElementById('simplex-rx-filename');
                if (fileEl) fileEl.textContent = `${name} — downloading...`;
                const fillEl = document.getElementById('simplex-rx-fill');
                if (fillEl) fillEl.style.width = '100%';
                const pctEl = document.getElementById('simplex-rx-pct');
                if (pctEl) pctEl.textContent = '100%';
                const chunksEl = document.getElementById('simplex-rx-chunks-big');
                if (chunksEl) chunksEl.textContent = 'DONE';
            } else {
                this._addSystemMessage(`File received: ${name} (${data.length} bytes)`);
            }
        };

        // Protocol callbacks
        this.protocol.onStateChange = (state) => this._onStateChange(state);
        this.protocol.onMessageReceived = (text) => this._onMessageReceived(text);
        this.protocol.onStatsUpdate = () => this._updateStatsDom();
    }

    _goToStep(step) {
        // Cleanup current step
        if (this.wizardStep === 'calibrate') {
            this._stopCalibration();
        }
        if (this.wizardStep === 'session') {
            this._cleanupSession();
        }

        // Hide all steps
        document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));

        // Show target step
        this.wizardStep = step;

        switch (step) {
            case 'mode':
                document.getElementById('step-mode').classList.add('active');
                document.getElementById('header-status').style.display = 'none';
                break;
            case 'calibrate':
                document.getElementById('step-calibrate').classList.add('active');
                document.getElementById('header-status').style.display = 'flex';
                this._startCalibration();
                break;
            case 'session':
                document.getElementById('step-session').classList.add('active');
                document.getElementById('header-status').style.display = 'flex';
                this._startSession();
                break;
        }
    }

    _selectMode(mode) {
        this.sessionMode = mode;

        const isSimplexSend = mode === 'simplex-send';
        const isSimplexReceive = mode === 'simplex-receive';
        const isSend = mode === 'send-file' || isSimplexSend;
        const isReceive = mode === 'receive-file' || isSimplexReceive;

        // Show/hide mode-specific calibration UI
        document.getElementById('cal-file-select').style.display = isSend ? '' : 'none';
        document.getElementById('cal-save-section').style.display = isReceive ? '' : 'none';
        document.getElementById('cal-dtn-section').style.display = (mode === 'messaging') ? '' : 'none';

        // Set protocol mode (only for bidirectional)
        if (!isSimplexSend && !isSimplexReceive) {
            const modeMap = { 'send-file': 0x01, 'receive-file': 0x02, 'messaging': 0x00 };
            this.protocol.setMode(modeMap[mode] || 0x00, 0);
        }

        this._goToStep('calibrate');
    }

    // ==================== CALIBRATION ====================

    async _startCalibration() {
        const isSimplexSend = this.sessionMode === 'simplex-send';
        const isSimplexReceive = this.sessionMode === 'simplex-receive';
        const isMessaging = this.sessionMode === 'messaging';
        const isSimplex = isSimplexSend || isSimplexReceive;

        // Reset protocol
        this.protocol.state = 'disconnected';
        this.protocol.peerId = null;
        this.protocol.simplexMode = false;

        // Show/hide simplex vs normal calibration panels
        const calCanvas = document.getElementById('calibrate-tx-canvas');
        const simplexRxPanel = document.getElementById('simplex-rx-cal-panel');
        const camSection = document.getElementById('cal-camera-section');
        const calCenter = document.getElementById('calibrate-qr-center');
        const msgCalCamCenter = document.getElementById('msg-cal-camera-center');

        calCanvas.style.display = isSimplexReceive ? 'none' : '';
        simplexRxPanel.style.display = isSimplexReceive ? '' : 'none';
        // For messaging: hide sidebar camera preview but keep camera select controls
        camSection.style.display = isSimplexSend ? 'none' : '';
        const calCamWrap = document.querySelector('.calibrate-camera-wrap');
        if (calCamWrap) calCamWrap.style.display = isMessaging ? 'none' : '';
        calCenter.classList.toggle('messaging-mode', isMessaging);
        if (msgCalCamCenter) msgCalCamCenter.style.display = isMessaging ? '' : 'none';

        if (!isSimplexReceive) {
            // Create calibration encoder with maximized QR
            this.calEncoder = new PhotonEncoder(calCanvas);
            this._applySettings();
            this._autoSizeCalQR();
            if (isSimplexSend) {
                this.calEncoder.renderIdle();
            }
        }

        if (!isSimplexSend) {
            // Start camera — for messaging, use center video; otherwise sidebar
            let calVideo, calDebug;
            if (isMessaging) {
                calVideo = document.getElementById('msg-cal-camera-feed');
                calDebug = document.getElementById('msg-cal-debug-canvas');
            } else {
                calVideo = document.getElementById('calibrate-camera-feed');
                calDebug = document.getElementById('calibrate-debug-canvas');
            }
            this.calCamera = new PhotonCamera(calVideo, calDebug);

            this._updateCalStatus('Waiting for camera...', '');
            const camOk = await this.calCamera.start();
            if (!camOk) {
                this._updateCalStatus('Camera failed! Grant permission and reload.', '');
            } else {
                this._populateCameraSelect();
                if (isMessaging) {
                    this._updateCalStatus('Position devices facing each other', 'beaconing');
                } else if (!isSimplex) {
                    this._updateCalStatus('Scanning for peer...', 'beaconing');
                } else {
                    this._updateCalStatus('Ready — point camera at sender', 'beaconing');
                }
            }

            if (isMessaging) {
                // Messaging: show idle QR, enable START immediately (no handshake)
                if (this.calEncoder) {
                    this.calEncoder.renderIdle();
                    this.txInterval = setInterval(() => {
                        if (this.calEncoder) {
                            this._autoSizeCalQR();
                            this.calEncoder.renderIdle();
                        }
                    }, PHOTON.FRAME_RATE_MS);
                }
                document.getElementById('start-session-btn').disabled = false;
            } else if (!isSimplex) {
                // Bidirectional file: start beacon exchange
                this.protocol.state = 'beaconing';
                this.txInterval = setInterval(() => this._calTxTick(), PHOTON.FRAME_RATE_MS);
                if (camOk) {
                    this.rxInterval = setInterval(() => this._calRxTick(), PHOTON.CAMERA_POLL_MS);
                }
            }
        } else {
            // Simplex-send: no camera, show preview QR that updates with settings
            this._updateCalStatus('Select a file to send', '');
            this.txInterval = setInterval(() => {
                if (this.calEncoder) {
                    this._autoSizeCalQR();
                    this.calEncoder.renderIdle();
                }
            }, PHOTON.FRAME_RATE_MS);
        }

        // Simplex modes: enable START button immediately for receive, on file-select for send
        if (isSimplexReceive) {
            document.getElementById('start-session-btn').disabled = false;
        }

        // Update device ID display
        document.getElementById('device-id-display').textContent =
            `ID: ${this.protocol.deviceId.toString(16).toUpperCase().padStart(4, '0')}`;
    }

    _stopCalibration() {
        if (this.txInterval) { clearInterval(this.txInterval); this.txInterval = null; }
        if (this.rxInterval) { clearInterval(this.rxInterval); this.rxInterval = null; }
        // Don't stop camera - we'll transfer it to session
    }

    _calTxTick() {
        // During calibration, just send beacons (or ACK beacons)
        const now = Date.now();
        if (this.lastAction && now < this.actionExpiry) {
            this.calEncoder.renderFrame(this.lastAction.frameType, this.lastAction.seqNum, this.lastAction.payload);
            this.calEncoder.toggleClock();
            return;
        }
        if (this.lastAction && now >= this.actionExpiry) this.lastAction = null;

        const frame = this.protocol.getNextTxFrame();
        if (frame) {
            this.calEncoder.renderFrame(frame.frameType, frame.seqNum, frame.payload);
            this.calEncoder.toggleClock();
        } else {
            this.calEncoder.renderIdle();
        }
    }

    _calRxTick() {
        if (!this.calCamera) return;
        const qrData = this.calCamera.scanQR();
        if (!qrData) return;

        const frame = this.decoder.decodeQR(qrData);
        if (!frame) return;

        const action = this.protocol.handleReceivedFrame(frame);
        if (action) {
            this.lastAction = action;
            this.actionExpiry = Date.now() + PHOTON.FRAME_RATE_MS * 2;
        }
    }

    _autoSizeCalQR() {
        if (!this.calEncoder) return;
        const container = document.querySelector('.calibrate-qr-center');
        if (!container) return;
        const modules = this.calEncoder.qrVersion * 4 + 17;
        let availW = container.clientWidth;
        let availH = container.clientHeight;
        if (this.sessionMode === 'messaging') {
            if (window.innerWidth <= 600) {
                availH = Math.floor(availH / 2) - 10;
            } else {
                availW = Math.floor(availW / 2) - 20;
            }
        }
        const maxDim = Math.min(availW, availH) - 40;
        const moduleSize = Math.max(4, Math.floor(maxDim / (modules + 3)));
        this.calEncoder.moduleSize = moduleSize;
    }

    _populateCameraSelect() {
        const select = document.getElementById('camera-select');
        select.innerHTML = '';
        const cameras = this.calCamera.cameras;
        cameras.forEach((cam, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = cam.label || `Camera ${i + 1}`;
            select.appendChild(opt);
        });
    }

    async _switchCamera(index) {
        if (!this.calCamera) return;
        this.calCamera.currentCameraIdx = parseInt(index);
        await this.calCamera._startCamera(parseInt(index));
    }

    async _switchSessionCamera(index) {
        if (!this.camera) return;
        this.camera.currentCameraIdx = parseInt(index);
        await this.camera._startCamera(parseInt(index));
    }

    _populateSessionCameraSelect() {
        const select = document.getElementById('camera-select-session');
        if (!select || !this.camera) return;
        select.innerHTML = '';
        const cameras = this.camera.cameras;
        cameras.forEach((cam, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = cam.label || `Camera ${i + 1}`;
            select.appendChild(opt);
        });
    }

    _updateCalStatus(text, dotClass) {
        document.getElementById('cal-status-text').textContent = text;
        document.getElementById('cal-footer-text').textContent = text;

        const dots = [
            document.getElementById('cal-status-dot'),
            document.getElementById('cal-footer-dot'),
            document.getElementById('status-dot')
        ];
        dots.forEach(d => { d.className = 'status-dot' + (dotClass ? ' ' + dotClass : ''); });

        document.getElementById('status-text').textContent = text;
    }

    _setPendingFile(file) {
        this.pendingFile = file;
        const info = document.getElementById('cal-file-info');
        info.textContent = `${file.name} (${this._formatSize(file.size)})`;

        if (this.sessionMode === 'simplex-send') {
            // Enable START immediately — no handshake needed
            document.getElementById('start-session-btn').disabled = false;
        } else {
            // Update protocol with file size for beacon metadata
            this.protocol.setMode(0x01, file.size);
        }
    }

    // ==================== SESSION ====================

    _startSession() {
        // Create session encoder on session canvas
        const txCanvas = document.getElementById('tx-canvas');
        this.encoder = new PhotonEncoder(txCanvas);
        this.encoder.qrVersion = this.calEncoder ? this.calEncoder.qrVersion : PHOTON.QR_VERSION;
        this.encoder.errorLevel = this.calEncoder ? this.calEncoder.errorLevel : PHOTON.QR_ERROR_LEVEL;
        this.encoder.clockState = this.calEncoder ? this.calEncoder.clockState : 0;

        // Sync the session selects to match calibration settings
        this._syncSessionSelects();

        // Transfer camera to session video (not needed for simplex-send)
        if (this.sessionMode !== 'simplex-send') {
            let sessionVideo, sessionDebug;
            if (this.sessionMode === 'messaging') {
                sessionVideo = document.getElementById('msg-camera-feed');
                sessionDebug = document.getElementById('msg-debug-canvas');
            } else {
                sessionVideo = document.getElementById('camera-feed');
                sessionDebug = document.getElementById('debug-canvas');
            }
            this.camera = new PhotonCamera(sessionVideo, sessionDebug);

            if (this.calCamera && this.calCamera.stream) {
                this.camera.stream = this.calCamera.stream;
                this.camera.cameras = this.calCamera.cameras;
                this.camera.currentCameraIdx = this.calCamera.currentCameraIdx;
                sessionVideo.srcObject = this.calCamera.stream;
                sessionVideo.play().catch(() => {});
                this.camera.captureCanvas.width = this.calCamera.captureCanvas.width;
                this.camera.captureCanvas.height = this.calCamera.captureCanvas.height;
                if (sessionDebug) {
                    sessionDebug.width = this.calCamera.captureCanvas.width;
                    sessionDebug.height = this.calCamera.captureCanvas.height;
                }
            }
            // Populate session camera select for messaging
            if (this.sessionMode === 'messaging') {
                this._populateSessionCameraSelect();
            }
        }

        // Configure UI per mode
        const modeLabel = document.getElementById('session-mode-label');
        const chatWrap = document.getElementById('sess-chat-wrap');
        const fileWrap = document.getElementById('sess-file-wrap');
        const fileDropWrap = document.getElementById('session-file-drop-wrap');
        const transferBar = document.getElementById('transfer-bar');

        const simplexTxWrap = document.getElementById('sess-simplex-tx-wrap');
        const simplexRxPanel = document.getElementById('simplex-rx-session-panel');
        const camWrap = document.querySelector('.sess-camera-wrap');
        const camHideBtn = document.getElementById('camera-hide-btn');

        switch (this.sessionMode) {
            case 'messaging':
                modeLabel.textContent = 'MSG';
                chatWrap.style.display = '';
                fileWrap.style.display = 'none';
                // Show camera in center, hide sidebar camera preview
                document.getElementById('session-qr-center').classList.add('messaging-mode');
                document.getElementById('msg-camera-center').style.display = '';
                if (camWrap) camWrap.parentElement.style.display = 'none';
                if (camHideBtn) camHideBtn.style.display = 'none';
                // Show camera select in sidebar
                document.getElementById('sess-msg-camera-section').style.display = '';
                break;
            case 'send-file':
                modeLabel.textContent = 'TX FILE';
                chatWrap.style.display = 'none';
                fileWrap.style.display = '';
                fileDropWrap.style.display = '';
                if (transferBar) transferBar.style.display = '';
                break;
            case 'receive-file':
                modeLabel.textContent = 'RX FILE';
                chatWrap.style.display = 'none';
                fileWrap.style.display = '';
                if (fileDropWrap) fileDropWrap.style.display = 'none';
                if (transferBar) transferBar.style.display = '';
                break;
            case 'simplex-send':
                modeLabel.textContent = 'TX 1-WAY';
                chatWrap.style.display = 'none';
                fileWrap.style.display = 'none';
                if (simplexTxWrap) simplexTxWrap.style.display = '';
                // Hide camera — sender doesn't need it
                if (camWrap) camWrap.style.display = 'none';
                if (camHideBtn) camHideBtn.style.display = 'none';
                break;
            case 'simplex-receive':
                modeLabel.textContent = 'RX 1-WAY';
                chatWrap.style.display = 'none';
                fileWrap.style.display = 'none';
                // Show RX panel on left, hide QR canvas
                if (simplexRxPanel) simplexRxPanel.style.display = '';
                if (txCanvas) txCanvas.style.display = 'none';
                break;
        }

        // Auto-size QR to fill the white area (only if QR canvas is visible)
        if (this.sessionMode !== 'simplex-receive') {
            requestAnimationFrame(() => this._autoSizeSessionQR());
        }

        // Update capacity display
        this._updateCapacityDisplay();

        // For simplex-send: set connected immediately, no camera needed
        if (this.sessionMode === 'simplex-send') {
            this.protocol.enableSimplex();
        }

        // Start TX/RX loops
        this.isPaused = false;
        this.txInterval = setInterval(() => this._txTick(), PHOTON.FRAME_RATE_MS);
        this.rxInterval = setInterval(() => this._rxTick(), PHOTON.CAMERA_POLL_MS);

        // Simplex post-start: adjust which loops actually run
        if (this.sessionMode === 'simplex-send') {
            clearInterval(this.rxInterval);
            this.rxInterval = null;
            if (this.pendingFile) {
                this._startSimplexSend(this.pendingFile);
                this.pendingFile = null;
            }
        } else if (this.sessionMode === 'simplex-receive') {
            clearInterval(this.txInterval);
            this.txInterval = null;
            clearInterval(this.rxInterval);
            // Reset decoder and enable simplex mode (disables clock dedup)
            this.decoder.reset();
            this.decoder.simplexMode = true;
            this.simplexScanCount = 0;
            this.simplexDecodeCount = 0;
            this.rxInterval = setInterval(() => this._simplexRxTick(), PHOTON.CAMERA_POLL_MS);
        } else if (this.sessionMode === 'messaging') {
            // Half-duplex messaging: no handshake, immediate connected
            this.protocol.enableSimplex();
            this.decoder.reset();
            this.decoder.simplexMode = true;
            this.msgState = 'idle';
            this.msgAckId = null;
            this.fileTransfer.msgReceiving = null;

            // Replace default TX/RX with combined messaging tick
            clearInterval(this.txInterval);
            clearInterval(this.rxInterval);
            this.txInterval = null;
            this.rxInterval = null;
            this.msgLastTxTime = 0;
            // Single RX loop that also handles TX
            this.rxInterval = setInterval(() => this._msgTick(), PHOTON.CAMERA_POLL_MS);

            // Enable chat
            document.getElementById('msg-input').disabled = false;
            document.getElementById('send-btn').disabled = false;
            document.getElementById('msg-input').focus();
        }

        this._acquireWakeLock();
        this._addSystemMessage(`Session started — ${this.sessionMode}`);

        // Auto-send pending file (bidirectional)
        if (this.sessionMode === 'send-file' && this.pendingFile) {
            this._sendFile(this.pendingFile);
            this.pendingFile = null;
        }
    }

    _autoSizeSessionQR() {
        if (!this.encoder) return;
        const container = document.querySelector('.session-qr-center');
        if (!container) return;
        const modules = this.encoder.qrVersion * 4 + 17;
        // In messaging mode, QR only gets half the width (desktop) or half height (mobile)
        let availW = container.clientWidth;
        let availH = container.clientHeight;
        if (this.sessionMode === 'messaging') {
            if (window.innerWidth <= 600) {
                // Mobile: stacked vertically, QR gets half height but full width
                availH = Math.floor(availH / 2) - 10;
            } else {
                // Desktop: side by side, QR gets half width
                availW = Math.floor(availW / 2) - 20;
            }
        }
        const maxDim = Math.min(availW, availH) - 40;
        this.encoder.moduleSize = Math.max(4, Math.floor(maxDim / (modules + 3)));
    }

    _syncSessionSelects() {
        const v = document.getElementById('qr-version');
        const e = document.getElementById('qr-error-level');
        const f = document.getElementById('frame-rate');
        const vs = document.getElementById('qr-version-session');
        const es = document.getElementById('qr-error-level-session');
        const fs = document.getElementById('frame-rate-session');
        if (v && vs) vs.value = v.value;
        if (e && es) es.value = e.value;
        if (f && fs) fs.value = f.value;
    }

    _applySessionSettings() {
        const version = parseInt(document.getElementById('qr-version-session').value);
        const errorLevel = document.getElementById('qr-error-level-session').value;
        const frameRate = parseInt(document.getElementById('frame-rate-session').value);

        PHOTON.QR_VERSION = version;
        PHOTON.QR_ERROR_LEVEL = errorLevel;
        PHOTON.FRAME_RATE_MS = frameRate;
        PHOTON.init();

        if (this.encoder) {
            this.encoder.qrVersion = version;
            this.encoder.errorLevel = errorLevel;
            this._autoSizeSessionQR();
        }

        if (this.sessionMode === 'messaging') {
            // Messaging uses rxInterval for combined tick — just update encoder settings
            if (this.rxInterval) {
                clearInterval(this.rxInterval);
                this.rxInterval = setInterval(() => this._msgTick(), PHOTON.CAMERA_POLL_MS);
            }
        } else if (this.txInterval) {
            clearInterval(this.txInterval);
            this.txInterval = setInterval(() => this._txTick(), PHOTON.FRAME_RATE_MS);
        }

        this._updateCapacityDisplay();
    }

    _cleanupSession() {
        if (this.txInterval) { clearInterval(this.txInterval); this.txInterval = null; }
        if (this.rxInterval) { clearInterval(this.rxInterval); this.rxInterval = null; }
        if (this.camera) { this.camera.stop(); this.camera = null; }
        if (this.calCamera) { this.calCamera.stop(); this.calCamera = null; }
    }

    async _startSimplexSend(file) {
        this._addSystemMessage(`Building simplex TX: ${file.name} (${this._formatSize(file.size)})`);
        const { frames, totalChunks } = await this.fileTransfer.buildSimplexFrames(file);

        this.protocol.currentTxFrames = frames;
        this.protocol.currentTxIndex = 0;
        this.protocol.simplexLoopCount = 0;

        const chunkEl = document.getElementById('simplex-chunk-display');
        if (chunkEl) chunkEl.textContent = `0 / ${frames.length}`;
        this._addSystemMessage(`Loaded ${frames.length} frames (${totalChunks} data chunks) — looping`);
    }

    _simplexRxTick() {
        if (!this.camera) return;
        const qrData = this.camera.scanQR();
        if (!qrData) return;

        // QR detected by jsQR
        this.simplexScanCount = (this.simplexScanCount || 0) + 1;

        const frame = this.decoder.decodeQR(qrData);
        if (!frame || !frame.valid) {
            this._updateSimplexDebug();
            return;
        }

        // Frame successfully decoded
        this.simplexDecodeCount = (this.simplexDecodeCount || 0) + 1;
        this.fileTransfer.handleSimplexFrame(frame.payload);
        this._updateSimplexRxDisplay();
        this._updateSimplexDebug();
    }

    _updateSimplexDebug() {
        const scansEl = document.getElementById('simplex-rx-scans');
        const decodedEl = document.getElementById('simplex-rx-decoded');
        const errorsEl = document.getElementById('simplex-rx-errors');
        if (scansEl) scansEl.textContent = this.simplexScanCount || 0;
        if (decodedEl) decodedEl.textContent = this.simplexDecodeCount || 0;
        if (errorsEl) errorsEl.textContent = this.decoder.errorCount || 0;
    }

    _updateSimplexRxDisplay() {
        const rx = this.fileTransfer.receiving;
        const panel = document.getElementById('simplex-rx-session-panel');
        if (!panel) return;

        if (!rx) return;

        const received = Object.keys(rx.chunks).length;
        const total = rx.totalChunks || 0;
        const pct = total > 0 ? Math.round(received / total * 100) : 0;

        const chunksEl = document.getElementById('simplex-rx-chunks-big');
        if (chunksEl) chunksEl.textContent = `${received} / ${total || '?'}`;
        const fileEl = document.getElementById('simplex-rx-filename');
        if (fileEl) fileEl.textContent = rx.name;
        const fillEl = document.getElementById('simplex-rx-fill');
        if (fillEl) fillEl.style.width = `${pct}%`;
        const pctEl = document.getElementById('simplex-rx-pct');
        if (pctEl) pctEl.textContent = `${pct}%`;
    }

    _stopSession() {
        this._cleanupSession();
        this._releaseWakeLock();
        // Reset protocol
        this.protocol.state = 'disconnected';
        this.protocol.peerId = null;
        this.protocol.simplexMode = false;
        this.protocol.simplexLoopCount = 0;
        this.protocol.txQueue = [];
        this.protocol.currentTxFrames = [];
        this.protocol.currentTxIndex = 0;
        this.protocol.rxBuffer = {};
        this.fileTransfer.sending = null;
        this.fileTransfer.receiving = null;
        this.fileTransfer.msgReceiving = null;
        this.decoder.reset();
        this.decoder.simplexMode = false;
        this.pendingFile = null;

        // Reset messaging state
        this.msgState = 'idle';
        this.msgAckId = null;
        this.msgPendingDelivery = null;
        if (this.msgAckTimer) { clearTimeout(this.msgAckTimer); this.msgAckTimer = null; }

        // Reset messaging mode layout
        const sessionCenter = document.getElementById('session-qr-center');
        if (sessionCenter) sessionCenter.classList.remove('messaging-mode');
        const msgCamCenter = document.getElementById('msg-camera-center');
        if (msgCamCenter) msgCamCenter.style.display = 'none';
        const calCenter = document.getElementById('calibrate-qr-center');
        if (calCenter) calCenter.classList.remove('messaging-mode');
        const msgCalCam = document.getElementById('msg-cal-camera-center');
        if (msgCalCam) msgCalCam.style.display = 'none';

        // Restore sidebar camera section visibility
        const msgCamSection = document.getElementById('sess-msg-camera-section');
        if (msgCamSection) msgCamSection.style.display = 'none';
        const sidebarCamWrap = document.querySelector('.sess-camera-wrap');
        if (sidebarCamWrap) { sidebarCamWrap.style.display = ''; sidebarCamWrap.parentElement.style.display = ''; }
        const camHideBtn = document.getElementById('camera-hide-btn');
        if (camHideBtn) { camHideBtn.style.display = ''; camHideBtn.textContent = 'Hide Camera'; }
        // Restore TX canvas visibility
        const txCanvas = document.getElementById('tx-canvas');
        if (txCanvas) txCanvas.style.display = '';
        // Restore simplex panels
        const simplexRxPanel = document.getElementById('simplex-rx-session-panel');
        if (simplexRxPanel) simplexRxPanel.style.display = 'none';
        const simplexTxWrap = document.getElementById('sess-simplex-tx-wrap');
        if (simplexTxWrap) simplexTxWrap.style.display = 'none';

        this._goToStep('mode');
    }

    _togglePause() {
        this.isPaused = !this.isPaused;
        const btn = document.getElementById('pause-btn');
        if (this.isPaused) {
            btn.textContent = 'Resume';
            if (this.txInterval) { clearInterval(this.txInterval); this.txInterval = null; }
            this._addSystemMessage('Paused - not transmitting');
        } else {
            btn.textContent = 'Pause';
            this.txInterval = setInterval(() => this._txTick(), PHOTON.FRAME_RATE_MS);
            this._addSystemMessage('Resumed');
        }
    }

    // ==================== TX / RX ====================

    _txTick() {
        const now = Date.now();

        if (this.lastAction && now < this.actionExpiry) {
            this.encoder.renderFrame(this.lastAction.frameType, this.lastAction.seqNum, this.lastAction.payload);
            this.encoder.toggleClock();
            this._updateStatsDom();
            return;
        }
        if (this.lastAction && now >= this.actionExpiry) this.lastAction = null;

        const frame = this.protocol.getNextTxFrame();
        if (frame) {
            this.encoder.renderFrame(frame.frameType, frame.seqNum, frame.payload);
            this.encoder.toggleClock();
        } else {
            this.encoder.renderIdle();
        }
        this._updateStatsDom();
    }

    _rxTick() {
        if (!this.camera) return;
        const qrData = this.camera.scanQR();
        if (!qrData) return;

        const frame = this.decoder.decodeQR(qrData);
        if (!frame) return;

        const action = this.protocol.handleReceivedFrame(frame);
        if (action) {
            this.lastAction = action;
            this.actionExpiry = Date.now() + PHOTON.FRAME_RATE_MS * 2;
        }
    }

    // ==================== STATE CHANGES ====================

    _onStateChange(state) {
        // Update header status
        const headerDot = document.getElementById('status-dot');
        const headerText = document.getElementById('status-text');
        if (headerDot) headerDot.className = 'status-dot ' + state;

        let statusMsg = '';
        switch (state) {
            case 'disconnected': statusMsg = 'Disconnected'; break;
            case 'beaconing':    statusMsg = 'Scanning...'; break;
            case 'connected':
                statusMsg = this.protocol.simplexMode
                    ? 'SIMPLEX MODE'
                    : `Connected: ${this.protocol.peerId.toString(16).toUpperCase().padStart(4, '0')}`;
                break;
        }
        if (headerText) headerText.textContent = statusMsg;

        // Update session sidebar status
        const sesDot = document.getElementById('ses-status-dot');
        const sesText = document.getElementById('ses-status-text');
        if (sesDot) sesDot.className = 'status-dot ' + state;
        if (sesText) sesText.textContent = statusMsg;

        document.getElementById('stat-state').textContent = (state || 'IDLE').toUpperCase();

        // During calibration: update cal status and enable Start
        if (this.wizardStep === 'calibrate') {
            if (state === 'connected' && !this.protocol.simplexMode) {
                this._updateCalStatus(
                    `Connected to ${this.protocol.peerId.toString(16).toUpperCase().padStart(4, '0')}`,
                    'connected'
                );
                document.getElementById('start-session-btn').disabled = false;

                // Show peer info
                if (this.protocol.peerFileSize > 0 && this.sessionMode === 'receive-file') {
                    this._addCalInfo(`Peer wants to send ${this._formatSize(this.protocol.peerFileSize)}`);
                }
            } else if (state === 'beaconing') {
                this._updateCalStatus('Scanning for peer...', 'beaconing');
                document.getElementById('start-session-btn').disabled = true;
            }
        }

        // During session
        if (this.wizardStep === 'session' && state === 'connected') {
            if (this.protocol.simplexMode) {
                this._addSystemMessage('Simplex mode active');
            } else {
                this._addSystemMessage(
                    `Link established with ${this.protocol.peerId.toString(16).toUpperCase().padStart(4, '0')}`
                );
            }
            if (this.sessionMode === 'messaging') {
                document.getElementById('msg-input').disabled = false;
                document.getElementById('send-btn').disabled = false;
                document.getElementById('msg-input').focus();
            }
        }
    }

    _addCalInfo(text) {
        const info = document.getElementById('cal-file-info');
        if (info) info.textContent = text;
    }

    // ==================== MESSAGING ====================

    _sendMessage() {
        const input = document.getElementById('msg-input');
        const text = input.value.trim();
        if (!text || this.protocol.state !== 'connected') return;
        input.value = '';

        if (this.sessionMode === 'messaging') {
            // Half-duplex: use message frame protocol
            this._msgSend(text);
            return;
        }

        // Legacy bidirectional protocol
        if (this.dtn.enabled) {
            this._addChatMessage(text, 'sent');
            this._addSystemMessage(`In flight... ETA: ${this.dtn.formatDelay(this.dtn.delayMs)}`);
            this.dtn.delaySend(text, (msg) => this.protocol.queueMessage(msg));
        } else {
            this.protocol.queueMessage(text);
            this._addChatMessage(text, 'sent');
        }
    }

    _onMessageReceived(text) {
        if (this.fileTransfer.handleMessage(text)) return;
        if (this.dtn.enabled) {
            this._addSystemMessage(`Arriving in ${this.dtn.formatDelay(this.dtn.delayMs)}...`);
            this.dtn.delayReceive(text, (msg) => this._addChatMessage(msg, 'received'));
        } else {
            this._addChatMessage(text, 'received');
        }
    }

    // ==================== HALF-DUPLEX MESSAGING ====================

    _msgSend(text) {
        if (this.msgState !== 'idle') {
            this._addSystemMessage('Wait for current transfer to finish');
            return;
        }

        const { frames, totalChunks, ackId } = this.fileTransfer.buildMessageFrames(text);
        this.protocol.currentTxFrames = frames;
        this.protocol.currentTxIndex = 0;
        this.protocol.simplexLoopCount = 0;
        this.msgAckId = ackId;
        this.msgState = 'sending';

        // Add chat message with pending delivery status
        const msgEl = this._addChatMessage(text, 'sent');
        this.msgPendingDelivery = msgEl;

        this._updateMsgStateBadge();
        this._addSystemMessage(`Sending (${totalChunks} chunks)...`);
    }

    _msgTick() {
        const now = Date.now();

        // TX: render at FRAME_RATE_MS intervals
        if (now - this.msgLastTxTime >= PHOTON.FRAME_RATE_MS) {
            this.msgLastTxTime = now;

            if (this.msgState === 'sending' || this.msgState === 'acking') {
                const frame = this.protocol.getNextTxFrame();
                if (frame) {
                    this.encoder.renderFrame(frame.frameType, frame.seqNum, frame.payload);
                    this.encoder.toggleClock();
                } else {
                    this.encoder.renderIdle();
                }

                // Check send timeout (5 loops)
                if (this.msgState === 'sending' && this.protocol.simplexLoopCount >= 5) {
                    this._msgTimeout();
                }
            } else {
                this.encoder.renderIdle();
            }
            this._updateStatsDom();
        }

        // RX: scan camera every tick
        if (!this.camera) return;
        const qrData = this.camera.scanQR();
        if (!qrData) return;

        const frame = this.decoder.decodeQR(qrData);
        if (!frame || !frame.valid) return;

        // Check if it's a message frame (0xE0 prefix)
        if (frame.payload && frame.payload.length >= 2 && frame.payload[0] === 0xE0) {
            const result = this.fileTransfer.handleMessageFrame(frame.payload);
            if (result) this._msgHandleResult(result);
        }
    }

    _msgHandleResult(result) {
        switch (result.type) {
            case 'msg_start':
                if (this.msgState === 'idle' || this.msgState === 'receiving') {
                    this.msgState = 'receiving';
                    this._updateMsgStateBadge();
                }
                break;

            case 'msg_data':
                if (this.msgState === 'receiving') {
                    // Could show progress, but messages are usually small
                }
                break;

            case 'msg_complete':
                // Full message received — show in chat
                this._addChatMessage(result.text, 'received');
                this._addSystemMessage('Message received');
                // Start acking
                this._msgStartAcking(result.ackId);
                break;

            case 'msg_ack':
                if (this.msgState === 'sending' && result.ackId === this.msgAckId) {
                    // Delivered!
                    this._msgDelivered();
                }
                break;
        }
    }

    _msgStartAcking(ackId) {
        this.msgState = 'acking';
        this._updateMsgStateBadge();

        // Load ACK frames into TX loop
        const ackFrames = this.fileTransfer.buildAckFrames(ackId);
        this.protocol.currentTxFrames = ackFrames;
        this.protocol.currentTxIndex = 0;
        this.protocol.simplexLoopCount = 0;

        // ACK for 2 seconds then go idle
        if (this.msgAckTimer) clearTimeout(this.msgAckTimer);
        this.msgAckTimer = setTimeout(() => {
            this.msgState = 'idle';
            this.protocol.currentTxFrames = [];
            this.protocol.currentTxIndex = 0;
            this._updateMsgStateBadge();
            this.msgAckTimer = null;
        }, 2000);
    }

    _msgDelivered() {
        this.msgState = 'idle';
        this.protocol.currentTxFrames = [];
        this.protocol.currentTxIndex = 0;
        this.msgAckId = null;

        // Update the sent message with delivered indicator
        if (this.msgPendingDelivery) {
            const indicator = document.createElement('div');
            indicator.className = 'delivered';
            indicator.textContent = 'delivered';
            this.msgPendingDelivery.appendChild(indicator);
            this.msgPendingDelivery = null;
        }

        this._addSystemMessage('Delivered');
        this._updateMsgStateBadge();
    }

    _msgTimeout() {
        this.msgState = 'idle';
        this.protocol.currentTxFrames = [];
        this.protocol.currentTxIndex = 0;
        this.msgAckId = null;

        if (this.msgPendingDelivery) {
            const indicator = document.createElement('div');
            indicator.className = 'unconfirmed';
            indicator.textContent = 'sent (unconfirmed)';
            this.msgPendingDelivery.appendChild(indicator);
            this.msgPendingDelivery = null;
        }

        this._addSystemMessage('No ACK received — sent unconfirmed');
        this._updateMsgStateBadge();
    }

    _updateMsgStateBadge() {
        const badge = document.getElementById('session-mode-label');
        if (!badge || this.sessionMode !== 'messaging') return;
        const stateText = { idle: 'IDLE', sending: 'SENDING', receiving: 'RECEIVING', acking: 'ACKING' };
        badge.textContent = stateText[this.msgState] || 'MSG';
        badge.className = 'sess-mode-badge msg-state-badge ' + this.msgState;
    }

    // ==================== FILE TRANSFER ====================

    _sendFile(file) {
        if (this.protocol.state !== 'connected') {
            this._addSystemMessage('Connect first before sending files');
            return;
        }
        this._addSystemMessage(`Sending: ${file.name} (${this._formatSize(file.size)})`);
        this.fileTransfer.sendFile(file);
    }

    _updateTransferProgress(p) {
        const bar = document.getElementById('transfer-bar');
        bar.style.display = '';

        const pct = p.total > 0 ? Math.round(((p.received || p.sent || 0) / p.total) * 100) : 0;

        document.getElementById('transfer-filename').textContent = p.name;
        document.getElementById('transfer-size').textContent = this._formatSize(p.total);
        document.getElementById('transfer-percent').textContent = `${pct}%`;
        document.getElementById('transfer-progress-fill').style.width = `${pct}%`;

        // Speed and ETA
        if (p.speed !== undefined) {
            document.getElementById('transfer-speed').textContent = `${this._formatSize(p.speed)}/s`;
        }
        if (p.eta !== undefined && p.eta > 0) {
            document.getElementById('transfer-eta').textContent = `ETA: ${this._formatTime(p.eta)}`;
        }

        // Also log to chat
        if (pct >= 100) {
            this._addSystemMessage(`Transfer complete: ${p.name}`);
            setTimeout(() => {
                if (!this.fileTransfer.sending && !this.fileTransfer.receiving) {
                    bar.style.display = 'none';
                }
            }, 3000);
        }
    }

    // ==================== SETTINGS ====================

    _applySettings() {
        const version = parseInt(document.getElementById('qr-version').value);
        const errorLevel = document.getElementById('qr-error-level').value;
        const frameRate = parseInt(document.getElementById('frame-rate').value);

        PHOTON.QR_VERSION = version;
        PHOTON.QR_ERROR_LEVEL = errorLevel;
        PHOTON.FRAME_RATE_MS = frameRate;
        PHOTON.init();

        // Update calibration encoder
        if (this.calEncoder) {
            this.calEncoder.qrVersion = version;
            this.calEncoder.errorLevel = errorLevel;
        }

        // Update session encoder
        if (this.encoder) {
            this.encoder.qrVersion = version;
            this.encoder.errorLevel = errorLevel;
        }

        // Restart TX interval with new rate
        if (this.txInterval) {
            clearInterval(this.txInterval);
            if (this.wizardStep === 'calibrate') {
                if (this.sessionMode === 'simplex-send' || this.sessionMode === 'messaging') {
                    this.txInterval = setInterval(() => {
                        if (this.calEncoder) {
                            this._autoSizeCalQR();
                            this.calEncoder.renderIdle();
                        }
                    }, PHOTON.FRAME_RATE_MS);
                } else {
                    this.txInterval = setInterval(() => this._calTxTick(), PHOTON.FRAME_RATE_MS);
                }
            } else if (this.wizardStep === 'session') {
                if (this.sessionMode === 'messaging') {
                    // Messaging uses rxInterval for combined tick, no txInterval
                } else {
                    this.txInterval = setInterval(() => this._txTick(), PHOTON.FRAME_RATE_MS);
                }
            }
        }

        // Recalculate auto-size for calibration QR
        if (this.wizardStep === 'calibrate') {
            this._autoSizeCalQR();
        }

        this._updateCapacityDisplay();
    }

    _updateCapacityDisplay() {
        const enc = this.calEncoder || this.encoder;
        if (!enc) return;
        const cap = enc.getCapacity();
        const bps = Math.round(cap * 1000 / PHOTON.FRAME_RATE_MS);
        const text = `${cap} bytes/frame | ~${bps} B/s`;

        const calCap = document.getElementById('cal-capacity-display');
        const sesCap = document.getElementById('capacity-display');
        if (calCap) calCap.textContent = text;
        if (sesCap) sesCap.textContent = text;
    }

    _toggleCameraVisibility() {
        const wrap = document.querySelector('.sess-camera-wrap');
        const btn = document.getElementById('camera-hide-btn');
        if (!wrap) return;
        if (wrap.style.display === 'none') {
            wrap.style.display = '';
            btn.textContent = 'Hide Camera';
            if (this.camera) this.camera.setVisible(true);
        } else {
            wrap.style.display = 'none';
            btn.textContent = 'Show Camera';
            if (this.camera) this.camera.setVisible(false);
        }
    }

    // ==================== WAKE LOCK ====================

    async _acquireWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
            } catch (e) { /* non-critical */ }
        }
    }

    _releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release().catch(() => {});
            this.wakeLock = null;
        }
    }

    // ==================== LOOPBACK TEST ====================

    _runLoopback() {
        this._addSystemMessage('--- LOOPBACK TEST ---');
        const testMsg = 'Hi PHOTON!';
        const bytes = new TextEncoder().encode(testMsg);
        const cap = this.encoder.getCapacity();
        this._addSystemMessage(`Capacity: ${cap} bytes/frame`);
        this._addSystemMessage(`Encoding: "${testMsg}" (${bytes.length} bytes)`);

        this.encoder.renderFrame(PHOTON.FRAME_TYPE.DATA, 42, bytes);
        const b64 = this.encoder.lastRendered;
        if (!b64) { this._addSystemMessage('ENCODE FAILED'); return; }

        const decoder = new PhotonDecoder();
        const frame = decoder.decodeQR(b64);
        if (!frame) { this._addSystemMessage('DECODE FAILED'); return; }

        const decoded = new TextDecoder().decode(frame.payload);
        this._addSystemMessage(`Decoded: "${decoded}"`);
        this._addSystemMessage(decoded === testMsg ? 'LOOPBACK PASSED' : 'LOOPBACK FAILED');

        if (decoded === testMsg && this.protocol.state !== 'connected') {
            this.protocol.state = 'connected';
            this.protocol.peerId = 0xBEEF;
            this._onStateChange('connected');
        }
    }

    // ==================== UI HELPERS ====================

    _addChatMessage(text, type) {
        const msg = document.createElement('div');
        msg.className = `chat-msg ${type}`;
        const content = document.createElement('div');
        content.textContent = text;
        msg.appendChild(content);
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = new Date().toLocaleTimeString();
        msg.appendChild(meta);
        const chatArea = document.getElementById('chat-area');
        chatArea.appendChild(msg);
        chatArea.scrollTop = chatArea.scrollHeight;
        return msg;
    }

    _addSystemMessage(text) {
        const msg = document.createElement('div');
        msg.className = 'system-msg';
        msg.textContent = text;
        const chatArea = document.getElementById('chat-area');
        chatArea.appendChild(msg);
        chatArea.scrollTop = chatArea.scrollHeight;
    }

    _updateStatsDom() {
        const s = this.protocol.getStats();
        document.getElementById('stat-tx').textContent = s.framesSent;
        document.getElementById('stat-rx').textContent = s.framesReceived;
        document.getElementById('stat-errors').textContent = s.errors + this.decoder.errorCount;
        document.getElementById('stat-fec').textContent = this.decoder.fecCorrected;
        document.getElementById('stat-bps').textContent = s.bytesPerSec;

        // Simplex TX progress
        if (this.protocol.simplexMode && this.sessionMode === 'simplex-send') {
            const idx = this.protocol.currentTxIndex;
            const total = this.protocol.currentTxFrames.length;
            const loop = this.protocol.simplexLoopCount;
            const pct = total > 0 ? Math.round(idx / total * 100) : 0;

            const chunkEl = document.getElementById('simplex-chunk-display');
            if (chunkEl) chunkEl.textContent = `${idx} / ${total}`;
            const loopEl = document.getElementById('simplex-loop-display');
            if (loopEl) loopEl.textContent = `Pass ${loop + 1}`;
            const fillEl = document.getElementById('simplex-tx-fill');
            if (fillEl) fillEl.style.width = `${pct}%`;
            const pctEl = document.getElementById('simplex-tx-pct');
            if (pctEl) pctEl.textContent = `${pct}%`;
        }
    }

    _formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    _formatTime(seconds) {
        if (seconds < 60) return `${Math.round(seconds)}s`;
        if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
        return `${(seconds / 3600).toFixed(1)}h`;
    }
}

// Boot
window.addEventListener('load', () => {
    window.photon = new PhotonApp();
});
