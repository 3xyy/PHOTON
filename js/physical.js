// PHOTON Physical Layer - Camera capture and QR code detection using jsQR

class PhotonCamera {
    constructor(videoElement, debugCanvas, facingMode) {
        this.video = videoElement;
        this.debugCanvas = debugCanvas;
        this.debugCtx = debugCanvas ? debugCanvas.getContext('2d') : null;
        this.stream = null;
        this.captureCanvas = document.createElement('canvas');
        this.captureCtx = this.captureCanvas.getContext('2d', { willReadFrequently: true });
        this.cameras = [];
        this.currentCameraIdx = 0;
        this.visible = true;
        this.preferredFacingMode = facingMode || 'environment';
    }

    async start() {
        try {
            // Enumerate cameras
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.cameras = devices.filter(d => d.kind === 'videoinput');

            return await this._startCamera(this.currentCameraIdx);
        } catch (err) {
            console.error('Camera start failed:', err);
            return false;
        }
    }

    async _startCamera(index) {
        try {
            if (this.stream) {
                this.stream.getTracks().forEach(t => t.stop());
            }

            const deviceId = this.cameras[index]?.deviceId;
            const constraints = {
                video: deviceId
                    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
                    : { facingMode: this.preferredFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } }
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = this.stream;
            this.video.setAttribute('playsinline', 'true');
            await this.video.play();

            this.captureCanvas.width = this.video.videoWidth;
            this.captureCanvas.height = this.video.videoHeight;

            if (this.debugCanvas) {
                this.debugCanvas.width = this.video.videoWidth;
                this.debugCanvas.height = this.video.videoHeight;
            }

            return true;
        } catch (err) {
            console.error('Camera start failed:', err);
            return false;
        }
    }

    async toggleCamera() {
        if (this.cameras.length < 2) return false;
        this.currentCameraIdx = (this.currentCameraIdx + 1) % this.cameras.length;
        return await this._startCamera(this.currentCameraIdx);
    }

    getCameraCount() {
        return this.cameras.length;
    }

    // Capture frame and attempt QR decode
    // Returns decoded data as Uint8Array or null
    scanQR() {
        if (!this.video.videoWidth) return null;

        this.captureCtx.drawImage(this.video, 0, 0);
        const imageData = this.captureCtx.getImageData(
            0, 0, this.captureCanvas.width, this.captureCanvas.height
        );

        // Draw to debug canvas
        if (this.debugCtx && this.visible) {
            this.debugCtx.putImageData(imageData, 0, 0);
        }

        // Use jsQR to decode
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
        });

        if (code) {
            // Draw detection overlay
            if (this.debugCtx && this.visible) {
                this._drawDetection(code);
            }
            return code.data; // Returns the string data
        }

        return null;
    }

    _drawDetection(code) {
        const ctx = this.debugCtx;
        const loc = code.location;

        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(loc.topLeftCorner.x, loc.topLeftCorner.y);
        ctx.lineTo(loc.topRightCorner.x, loc.topRightCorner.y);
        ctx.lineTo(loc.bottomRightCorner.x, loc.bottomRightCorner.y);
        ctx.lineTo(loc.bottomLeftCorner.x, loc.bottomLeftCorner.y);
        ctx.closePath();
        ctx.stroke();

        // Green dot at center
        const cx = (loc.topLeftCorner.x + loc.bottomRightCorner.x) / 2;
        const cy = (loc.topLeftCorner.y + loc.bottomRightCorner.y) / 2;
        ctx.fillStyle = '#00ff88';
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
    }

    setVisible(visible) {
        this.visible = visible;
    }

    stop() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
    }
}
