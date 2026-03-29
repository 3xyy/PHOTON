// PHOTON FEC - Reed-Solomon Error Correction over GF(256)
// Simplified implementation focused on reliability

class GaloisField {
    constructor() {
        this.exp = new Array(512);
        this.log = new Array(256);
        let x = 1;
        for (let i = 0; i < 255; i++) {
            this.exp[i] = x;
            this.log[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11D;
        }
        for (let i = 255; i < 512; i++) this.exp[i] = this.exp[i - 255];
        this.log[0] = undefined; // log(0) is undefined
    }

    mul(a, b) {
        if (a === 0 || b === 0) return 0;
        return this.exp[this.log[a] + this.log[b]];
    }

    inverse(a) {
        if (a === 0) throw new Error('No inverse of 0');
        return this.exp[255 - this.log[a]];
    }
}

const GF = new GaloisField();

// Polynomial operations over GF(256)
function polyMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let i = 0; i < p.length; i++)
        for (let j = 0; j < q.length; j++)
            r[i + j] ^= GF.mul(p[i], q[j]);
    return r;
}

function polyEval(p, x) {
    let y = 0;
    for (let i = 0; i < p.length; i++)
        y = GF.mul(y, x) ^ p[i];
    return y;
}

function polyScale(p, x) {
    return p.map(c => GF.mul(c, x));
}

class ReedSolomon {
    constructor(nsym) {
        this.nsym = nsym;
        // Generator polynomial: prod((x - alpha^i), i=0..nsym-1)
        this.gen = [1];
        for (let i = 0; i < nsym; i++) {
            this.gen = polyMul(this.gen, [1, GF.exp[i]]);
        }
    }

    encode(data) {
        // Append nsym zero bytes, then compute remainder
        const padded = new Array(data.length + this.nsym).fill(0);
        for (let i = 0; i < data.length; i++) padded[i] = data[i];

        for (let i = 0; i < data.length; i++) {
            const coef = padded[i];
            if (coef !== 0) {
                for (let j = 1; j < this.gen.length; j++) {
                    padded[i + j] ^= GF.mul(this.gen[j], coef);
                }
            }
        }

        // Output = original data + ECC
        const out = new Uint8Array(data.length + this.nsym);
        for (let i = 0; i < data.length; i++) out[i] = data[i];
        for (let i = 0; i < this.nsym; i++) out[data.length + i] = padded[data.length + i];
        return out;
    }

    decode(received) {
        const msg = Array.from(received);
        const n = msg.length;

        // 1. Compute syndromes
        const synd = [];
        let hasErr = false;
        for (let i = 0; i < this.nsym; i++) {
            const s = polyEval(msg, GF.exp[i]);
            synd.push(s);
            if (s !== 0) hasErr = true;
        }

        if (!hasErr) {
            return { data: new Uint8Array(msg.slice(0, n - this.nsym)), corrected: 0 };
        }

        // 2. Berlekamp-Massey algorithm
        const errLoc = this._berlekampMassey(synd);
        const numErr = errLoc.length - 1;
        if (numErr * 2 > this.nsym) return null; // Too many errors

        // 3. Find error positions (Chien search)
        const errPos = [];
        for (let i = 0; i < n; i++) {
            if (polyEval(errLoc, GF.inverse(GF.exp[i])) === 0) {
                errPos.push(n - 1 - i);
            }
        }
        if (errPos.length !== numErr) return null; // Couldn't find all error positions

        // 4. Forney algorithm for error magnitudes
        // Syndrome polynomial (reversed)
        const syndPoly = synd.slice().reverse();
        // Error evaluator: (syndPoly * errLoc) mod x^nsym
        let omega = polyMul(syndPoly, errLoc);
        omega = omega.slice(omega.length - this.nsym);

        // Formal derivative of error locator
        const errLocPrime = [];
        for (let i = errLoc.length & 1; i < errLoc.length; i += 2) {
            errLocPrime.push(errLoc[i]);
        }

        // Calculate error values
        for (const pos of errPos) {
            const xi = GF.exp[n - 1 - pos]; // = alpha^(n-1-pos)
            const xiInv = GF.inverse(xi);

            const errLocPrimeVal = polyEval(errLocPrime, xiInv);
            if (errLocPrimeVal === 0) return null;

            const omegaVal = polyEval(omega, xiInv);
            const magnitude = GF.mul(xi, GF.mul(omegaVal, GF.inverse(errLocPrimeVal)));

            msg[pos] ^= magnitude;
        }

        // 5. Verify
        for (let i = 0; i < this.nsym; i++) {
            if (polyEval(msg, GF.exp[i]) !== 0) return null;
        }

        return { data: new Uint8Array(msg.slice(0, n - this.nsym)), corrected: errPos.length };
    }

    _berlekampMassey(synd) {
        let errLoc = [1];
        let oldLoc = [1];
        let L = 0;

        for (let i = 0; i < synd.length; i++) {
            let delta = synd[i];
            for (let j = 1; j < errLoc.length; j++) {
                delta ^= GF.mul(errLoc[errLoc.length - 1 - j], synd[i - j]);
            }

            oldLoc.push(0);

            if (delta !== 0) {
                if (oldLoc.length > errLoc.length) {
                    const newLoc = polyScale(oldLoc, delta);
                    oldLoc = polyScale(errLoc, GF.inverse(delta));
                    errLoc = newLoc;
                    L = i + 1 - L;
                }
                // errLoc = errLoc + delta * oldLoc
                const scaled = polyScale(oldLoc, delta);
                while (errLoc.length < scaled.length) errLoc.unshift(0);
                while (scaled.length < errLoc.length) scaled.unshift(0);
                for (let j = 0; j < errLoc.length; j++) {
                    errLoc[j] ^= scaled[j];
                }
            }
        }

        // Trim leading zeros
        while (errLoc.length > 1 && errLoc[0] === 0) errLoc.shift();
        return errLoc;
    }
}

// 8 ECC bytes = can correct up to 4 byte errors per frame
const PHOTON_RS = new ReedSolomon(8);
