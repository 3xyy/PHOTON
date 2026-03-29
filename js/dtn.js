// PHOTON DTN - Delay-Tolerant Networking (Mars Mode)
// Simulates interplanetary communication delays

class PhotonDTN {
    constructor() {
        this.enabled = false;
        this.delayMs = 0;
        this.txQueue = [];     // Messages waiting to be "transmitted" after delay
        this.rxQueue = [];     // Messages waiting to be "received" after delay
        this.onDelayedSend = null;
        this.onDelayedReceive = null;

        this.presets = {
            'none': { name: 'Direct Link', delay: 0, description: 'No delay' },
            'moon': { name: 'Earth → Moon', delay: 1300, description: '1.3 second light delay' },
            'mars-min': { name: 'Earth → Mars (closest)', delay: 182000, description: '3 min light delay' },
            'mars-max': { name: 'Earth → Mars (farthest)', delay: 1320000, description: '22 min light delay' },
            'jupiter': { name: 'Earth → Jupiter', delay: 2040000, description: '34 min light delay' },
            'voyager': { name: 'Earth → Voyager 1', delay: 75600000, description: '21 hours light delay' }
        };
    }

    enable(presetKey) {
        const preset = this.presets[presetKey];
        if (!preset) return;
        this.enabled = presetKey !== 'none';
        this.delayMs = preset.delay;
        return preset;
    }

    disable() {
        this.enabled = false;
        this.delayMs = 0;
    }

    // Wrap a send action with delay
    delaySend(message, callback) {
        if (!this.enabled) {
            callback(message);
            return;
        }

        const entry = {
            message,
            sentAt: Date.now(),
            arrivesAt: Date.now() + this.delayMs,
            callback
        };
        this.txQueue.push(entry);

        // Schedule delivery
        setTimeout(() => {
            const idx = this.txQueue.indexOf(entry);
            if (idx !== -1) this.txQueue.splice(idx, 1);
            callback(message);
        }, this.delayMs);
    }

    // Wrap a receive action with delay
    delayReceive(data, callback) {
        if (!this.enabled) {
            callback(data);
            return;
        }

        const entry = {
            data,
            receivedAt: Date.now(),
            arrivesAt: Date.now() + this.delayMs,
            callback
        };
        this.rxQueue.push(entry);

        setTimeout(() => {
            const idx = this.rxQueue.indexOf(entry);
            if (idx !== -1) this.rxQueue.splice(idx, 1);
            callback(data);
        }, this.delayMs);
    }

    // Get info about messages "in flight"
    getInFlight() {
        const now = Date.now();
        return {
            sending: this.txQueue.map(e => ({
                age: now - e.sentAt,
                remaining: e.arrivesAt - now,
                progress: (now - e.sentAt) / this.delayMs
            })),
            receiving: this.rxQueue.map(e => ({
                age: now - e.receivedAt,
                remaining: e.arrivesAt - now,
                progress: (now - e.receivedAt) / this.delayMs
            }))
        };
    }

    formatDelay(ms) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
        return `${(ms / 3600000).toFixed(1)}hr`;
    }
}
