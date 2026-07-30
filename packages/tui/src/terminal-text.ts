/**
 * Remove terminal control sequences from untrusted text before it is handed to Ink.
 * Model, MCP, tool and repository output is data, never terminal markup.
 */

const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x9c;

function skipCsi(input: string, offset: number): number {
  let i = offset;
  while (i < input.length) {
    const code = input.charCodeAt(i++);
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return i;
}

function skipControlString(input: string, offset: number, allowBel: boolean): number {
  let i = offset;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if ((allowBel && code === BEL) || code === ST) return i + 1;
    if (code === ESC && input.charCodeAt(i + 1) === 0x5c) return i + 2;
    i++;
  }
  return input.length;
}

/** Strip ANSI/ECMA-48 controls while preserving printable Unicode, tab and newline. */
export function sanitizeTerminalText(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);

    if (code === ESC) {
      const next = input.charCodeAt(i + 1);
      if (Number.isNaN(next)) break;
      if (next === 0x5b) {
        i = skipCsi(input, i + 2);
        continue;
      }
      // OSC may end with BEL or ST; DCS/SOS/PM/APC end with ST.
      if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i = skipControlString(input, i + 2, next === 0x5d);
        continue;
      }
      // Two-byte ESC controls and ESC sequences with intermediate bytes.
      i += 2;
      while (i < input.length) {
        const c = input.charCodeAt(i);
        if (c < 0x20 || c > 0x2f) break;
        i++;
      }
      if (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x7e) i++;
      continue;
    }

    // 8-bit C1 forms of DCS/CSI/SOS/OSC/PM/APC.
    if (code === 0x9b) {
      i = skipCsi(input, i + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      i = skipControlString(input, i + 1, code === 0x9d);
      continue;
    }

    // CR, BS, DEL and other C0/C1 controls can overwrite/reposition terminal content.
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      i++;
      continue;
    }

    // Bidi formatting controls can visually reorder an approval command.  ZWJ and
    // combining marks are intentionally preserved for valid graphemes.
    if (
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      i++;
      continue;
    }

    out += input[i++];
  }
  return out;
}
