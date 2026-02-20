import {Protocol} from "trac-peer";
import { bufferToBigInt, bigIntToDecimalString } from "trac-msb/src/utils/amountSerialization.js";
import b4a from "b4a";
import fs from "fs";

// ─── Keep the original invite/welcome helpers unchanged ────────────────────
const stableStringify = (value) => {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const parseArgFile = (raw) => {
    if (!raw) return null;
    let text = String(raw).trim();
    if (text.startsWith('@')) {
        try { text = fs.readFileSync(text.slice(1), 'utf8').trim(); } catch { return null; }
    }
    if (text.startsWith('b64:')) text = text.slice(4);
    if (text.startsWith('{')) { try { return JSON.parse(text); } catch {} }
    try {
        return JSON.parse(b4a.toString(b4a.from(text, 'base64')));
    } catch {}
    return null;
};
// ──────────────────────────────────────────────────────────────────────────

class PollProtocol extends Protocol {

    constructor(peer, base, options = {}) {
        super(peer, base, options);
    }

    async extendApi() {
        this.api.getPollData = async (pollId) => {
            return await this.getSigned('poll/' + pollId);
        };
    }

    /**
     * Maps terminal / SC-Bridge tx commands to contract functions.
     *
     * Usage examples:
     *   /tx --command '{ "op": "create_poll", "question": "Best chain?", "options": ["BTC","ETH","Trac"], "expires": 3600 }'
     *   /tx --command '{ "op": "cast_vote", "poll_id": "1", "option": 2 }'
     *   /tx --command '{ "op": "poll_results", "poll_id": "1" }'
     *   /tx --command 'list_polls'
     */
    mapTxCommand(command) {
        const obj = { type: '', value: null };

        // Simple string commands
        if (command === 'list_polls') {
            obj.type  = 'listPolls';
            obj.value = null;
            return obj;
        }

        // JSON payload commands
        const json = this.safeJsonParse(command);
        if (!json || json.op === undefined) return null;

        if (json.op === 'create_poll') {
            obj.type  = 'createPoll';
            obj.value = json;
            return obj;
        }

        if (json.op === 'cast_vote') {
            obj.type  = 'castVote';
            obj.value = json;
            return obj;
        }

        if (json.op === 'poll_results') {
            obj.type  = 'readPollResults';
            obj.value = json;
            return obj;
        }

        return null;
    }

    async printOptions() {
        console.log(' ');
        console.log('─── P2P Poll Creator Commands ───────────────────────────────');
        console.log('  /create_poll --question "..." --options "A,B,C" [--expires <sec>]');
        console.log('  /vote        --poll_id <id> --option <n>   (1-based index)');
        console.log('  /poll_results --poll_id <id>');
        console.log('  /list_polls');
        console.log(' ');
        console.log('─── System Commands ─────────────────────────────────────────');
        console.log('  /get --key "<key>" [--confirmed true|false]');
        console.log('  /stats | /msb | /exit | /help');
        console.log(' ');
        console.log('─── Sidechannel Commands ────────────────────────────────────');
        console.log('  /sc_join  --channel "<name>"');
        console.log('  /sc_send  --channel "<name>" --message "<text>"');
        console.log('  /sc_open  --channel "<name>"');
        console.log('  /sc_stats');
        console.log('─────────────────────────────────────────────────────────────');
    }

    async customCommand(input) {
        await super.tokenizeInput(input);

        // ── /create_poll ──────────────────────────────────────────────────
        if (this.input.startsWith('/create_poll')) {
            const args    = this.parseArgs(input);
            const question = args.question || args.q;
            const optRaw   = args.options  || args.opts || args.o;
            const expires  = args.expires  ? Number(args.expires) : 0;

            if (!question || !optRaw) {
                console.log('Usage: /create_poll --question "..." --options "A,B,C" [--expires <sec>]');
                return;
            }

            const options = String(optRaw).split(',').map(s => s.trim()).filter(Boolean);
            if (options.length < 2 || options.length > 10) {
                console.log('Provide between 2 and 10 options.');
                return;
            }

            const payload = JSON.stringify({ op: 'create_poll', question, options, expires });
            await this.peer.protocol.api.tx(payload);
            return;
        }

        // ── /vote ─────────────────────────────────────────────────────────
        if (this.input.startsWith('/vote')) {
            const args    = this.parseArgs(input);
            const poll_id = String(args.poll_id || args.id || '');
            const option  = Number(args.option  || args.opt || 0);

            if (!poll_id || !option) {
                console.log('Usage: /vote --poll_id <id> --option <n>  (option is 1-based)');
                return;
            }

            const payload = JSON.stringify({ op: 'cast_vote', poll_id, option });
            await this.peer.protocol.api.tx(payload);
            return;
        }

        // ── /poll_results ─────────────────────────────────────────────────
        if (this.input.startsWith('/poll_results')) {
            const args    = this.parseArgs(input);
            const poll_id = String(args.poll_id || args.id || '');

            if (!poll_id) {
                console.log('Usage: /poll_results --poll_id <id>');
                return;
            }

            const payload = JSON.stringify({ op: 'poll_results', poll_id });
            await this.peer.protocol.api.tx(payload);
            return;
        }

        // ── /list_polls ───────────────────────────────────────────────────
        if (this.input.startsWith('/list_polls')) {
            await this.peer.protocol.api.tx('list_polls');
            return;
        }

        // ── /get ──────────────────────────────────────────────────────────
        if (this.input.startsWith('/get')) {
            const m = input.match(/(?:^|\s)--key(?:=|\s+)(\"[^\"]+\"|'[^']+'|\S+)/);
            const raw = m ? m[1].trim() : null;
            if (!raw) {
                console.log('Usage: /get --key "<key>" [--confirmed true|false]');
                return;
            }
            const key = raw.replace(/^["'](.*)["']$/, '$1');
            const confirmedMatch   = input.match(/(?:^|\s)--confirmed(?:=|\s+)(\S+)/);
            const unconfirmedMatch = input.match(/(?:^|\s)--unconfirmed(?:=|\s+)?(\S+)?/);
            const confirmed = unconfirmedMatch ? false
                : confirmedMatch ? (confirmedMatch[1] === 'true' || confirmedMatch[1] === '1')
                : true;
            const v = confirmed ? await this.getSigned(key) : await this.get(key);
            console.log(v);
            return;
        }

        // ── /msb ──────────────────────────────────────────────────────────
        if (this.input.startsWith('/msb')) {
            const txv            = await this.peer.msbClient.getTxvHex();
            const peerMsbAddress = this.peer.msbClient.pubKeyHexToAddress(this.peer.wallet.publicKey);
            const entry          = await this.peer.msbClient.getNodeEntryUnsigned(peerMsbAddress);
            const balance        = entry?.balance ? bigIntToDecimalString(bufferToBigInt(entry.balance)) : 0;
            const feeBuf         = this.peer.msbClient.getFee();
            const fee            = feeBuf ? bigIntToDecimalString(bufferToBigInt(feeBuf)) : 0;
            console.log({
                peerMsbAddress,
                peerMsbBalance: balance,
                msbFee:         fee,
                connectedValidators: this.peer.msbClient.getConnectedValidatorsCount(),
                txv,
            });
            return;
        }

        // ── Sidechannel commands (kept from original, unchanged) ──────────
        if (this.input.startsWith('/sc_join')) {
            const args    = this.parseArgs(input);
            const name    = args.channel || args.ch || args.name;
            const invite  = parseArgFile(args.invite);
            const welcome = parseArgFile(args.welcome);
            if (!name) { console.log('Usage: /sc_join --channel "<name>"'); return; }
            if (!this.peer.sidechannel) { console.log('Sidechannel not initialized.'); return; }
            if (invite || welcome) this.peer.sidechannel.acceptInvite(String(name), invite, welcome);
            const ok = await this.peer.sidechannel.addChannel(String(name));
            console.log(ok ? 'Joined: ' + name : 'Join denied.');
            return;
        }

        if (this.input.startsWith('/sc_send')) {
            const args    = this.parseArgs(input);
            const name    = args.channel || args.ch || args.name;
            const message = args.message || args.msg;
            const invite  = parseArgFile(args.invite);
            if (!name || message === undefined) { console.log('Usage: /sc_send --channel "<name>" --message "<text>"'); return; }
            if (!this.peer.sidechannel) { console.log('Sidechannel not initialized.'); return; }
            if (invite) this.peer.sidechannel.acceptInvite(String(name), invite, null);
            await this.peer.sidechannel.addChannel(String(name));
            this.peer.sidechannel.broadcast(String(name), message, invite ? { invite } : undefined);
            return;
        }

        if (this.input.startsWith('/sc_open')) {
            const args    = this.parseArgs(input);
            const name    = args.channel || args.ch || args.name;
            const via     = args.via || this.peer.sidechannel?.entryChannel || null;
            const invite  = parseArgFile(args.invite);
            const welcome = parseArgFile(args.welcome) || (typeof this.peer.sidechannel?.getWelcome === 'function' ? this.peer.sidechannel.getWelcome(String(name)) : null);
            if (!name) { console.log('Usage: /sc_open --channel "<name>"'); return; }
            if (!this.peer.sidechannel) { console.log('Sidechannel not initialized.'); return; }
            if (!via) { console.log('No entry channel. Pass --via "<channel>".'); return; }
            this.peer.sidechannel.requestOpen(String(name), String(via), invite, welcome);
            console.log('Requested channel:', name);
            return;
        }

        if (this.input.startsWith('/sc_stats')) {
            if (!this.peer.sidechannel) { console.log('Sidechannel not initialized.'); return; }
            console.log({
                channels:        Array.from(this.peer.sidechannel.channels.keys()),
                connectionCount: this.peer.sidechannel.connections.size
            });
            return;
        }
    }
}

export default PollProtocol;