const START_CODE = Buffer.from([0, 0, 0, 1]);
const MAX_FRAGMENT_BYTES = 4 * 1024 * 1024;

export class H264RtpDepacketizer {
  #fragment: Buffer[] | null = null;
  #fragmentBytes = 0;
  #expectedSequence: number | null = null;

  push(payload: Buffer, sequenceNumber: number): Buffer[] {
    if (payload.length === 0) return [];
    if (this.#expectedSequence !== null && sequenceNumber !== this.#expectedSequence) this.#resetFragment();
    this.#expectedSequence = (sequenceNumber + 1) & 0xffff;
    const type = payload[0]! & 0x1f;
    if (type > 0 && type < 24) return [Buffer.concat([START_CODE, payload])];
    if (type === 24) return this.#stapA(payload);
    if (type === 28) return this.#fuA(payload);
    return [];
  }

  parameterSets(sdp: string): Buffer[] {
    const match = /sprop-parameter-sets=([^;\s]+)/i.exec(sdp);
    if (!match) return [];
    return match[1]!.split(",").flatMap((encoded) => {
      try {
        const nal = Buffer.from(encoded, "base64");
        return nal.length > 0 ? [Buffer.concat([START_CODE, nal])] : [];
      } catch {
        return [];
      }
    });
  }

  #stapA(payload: Buffer): Buffer[] {
    const packets: Buffer[] = [];
    let offset = 1;
    while (offset + 2 <= payload.length) {
      const length = payload.readUInt16BE(offset);
      offset += 2;
      if (length === 0 || offset + length > payload.length) return [];
      packets.push(Buffer.concat([START_CODE, payload.subarray(offset, offset + length)]));
      offset += length;
    }
    return offset === payload.length ? packets : [];
  }

  #fuA(payload: Buffer): Buffer[] {
    if (payload.length < 3) return [];
    const indicator = payload[0]!;
    const header = payload[1]!;
    const start = (header & 0x80) !== 0;
    const end = (header & 0x40) !== 0;
    const fragment = payload.subarray(2);
    if (start) {
      this.#fragment = [START_CODE, Buffer.from([(indicator & 0xe0) | (header & 0x1f)]), fragment];
      this.#fragmentBytes = START_CODE.length + 1 + fragment.length;
    } else if (this.#fragment) {
      this.#fragment.push(fragment);
      this.#fragmentBytes += fragment.length;
    } else {
      return [];
    }
    if (this.#fragmentBytes > MAX_FRAGMENT_BYTES) {
      this.#resetFragment();
      return [];
    }
    if (!end || !this.#fragment) return [];
    const complete = Buffer.concat(this.#fragment, this.#fragmentBytes);
    this.#resetFragment();
    return [complete];
  }

  #resetFragment(): void {
    this.#fragment = null;
    this.#fragmentBytes = 0;
  }
}
