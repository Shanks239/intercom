import {Contract} from 'trac-peer'

class PollContract extends Contract {

    constructor(protocol, options = {}) {
        super(protocol, options);

        // Create a poll (question + options + optional expiry)
        this.addSchema('createPoll', {
            value: {
                $$strict: true,
                $$type: "object",
                op:       { type: "string", min: 1, max: 64 },
                question: { type: "string", min: 1, max: 256 },
                options:  { type: "array",  min: 2, max: 10, items: { type: "string", min: 1, max: 128 } },
                expires:  { type: "number", optional: true }
            }
        });

        // Cast a vote on an existing poll
        this.addSchema('castVote', {
            value: {
                $$strict: true,
                $$type: "object",
                op:       { type: "string", min: 1, max: 64 },
                poll_id:  { type: "string", min: 1, max: 64 },
                option:   { type: "number" }
            }
        });

        // Read results for a poll
        this.addSchema('readPollResults', {
            value: {
                $$strict: true,
                $$type: "object",
                op:      { type: "string", min: 1, max: 64 },
                poll_id: { type: "string", min: 1, max: 64 }
            }
        });

        // List all polls (no payload needed)
        this.addFunction('listPolls');
    }

    /**
     * Creates a new poll.
     * Stores: polls/count, polls/index/<n>, poll/<id>
     */
    async createPoll() {
        const question = this.value.question;
        const options  = this.value.options;
        const expires  = this.value.expires ?? 0;

        // Validate options are not blank
        for (const opt of options) {
            this.assert(opt.trim().length > 0, new Error('Option cannot be blank'));
        }

        // Generate poll ID using a counter
        let count = await this.get('polls/count');
        if (count === null) count = 0;

        const pollId   = String(count + 1);
        const now      = await this.get('currentTime') ?? Date.now();
        const expiresAt = expires > 0 ? (now + expires * 1000) : 0;

        const pollData = {
            id:         pollId,
            question,
            options,
            createdBy:  this.address,
            createdAt:  now,
            expiresAt
        };

        this.assert(this.protocol.safeClone(pollData) !== null);

        await this.put('poll/' + pollId, pollData);
        await this.put('polls/index/' + pollId, pollId);
        await this.put('polls/count', count + 1);

        console.log('Poll created:', pollId, question);
    }

    /**
     * Casts a vote on a poll.
     * Rules: one vote per address, poll must exist, poll must not be expired.
     * Stores: vote/<poll_id>/<address>
     */
    async castVote() {
        const pollId     = this.value.poll_id;
        const optionIdx  = this.value.option; // 1-based

        const poll = await this.get('poll/' + pollId);
        if (poll === null) {
            return new Error('Poll not found: ' + pollId);
        }

        // Check expiry
        if (poll.expiresAt > 0) {
            const now = await this.get('currentTime') ?? Date.now();
            if (now > poll.expiresAt) {
                return new Error('Poll is closed');
            }
        }

        // Validate option index (1-based)
        this.assert(
            Number.isInteger(optionIdx) && optionIdx >= 1 && optionIdx <= poll.options.length,
            new Error('Invalid option index')
        );

        // One vote per address
        const voteKey = 'vote/' + pollId + '/' + this.address;
        const existing = await this.get(voteKey);
        if (existing !== null) {
            return new Error('Already voted on this poll');
        }

        await this.put(voteKey, optionIdx);
        console.log('Vote cast on poll', pollId, 'option', optionIdx, 'by', this.address);
    }

    /**
     * Reads and tallies results for a poll.
     * Does not modify state — read only.
     */
    async readPollResults() {
        const pollId = this.value.poll_id;

        const poll = await this.get('poll/' + pollId);
        if (poll === null) {
            console.log('Poll not found:', pollId);
            return;
        }

        // Tally votes
        const tallies = new Array(poll.options.length).fill(0);
        let totalVotes = 0;

        // Scan votes for this poll using address-based keys
        // We iterate by reading count and checking each stored vote
        const count = await this.get('polls/count') ?? 0;

        // We can't iterate by prefix natively, so we store a vote counter per poll
        const voteCount = await this.get('votes/count/' + pollId) ?? 0;
        for (let i = 1; i <= voteCount; i++) {
            const addr = await this.get('votes/addr/' + pollId + '/' + i);
            if (addr === null) continue;
            const choice = await this.get('vote/' + pollId + '/' + addr);
            if (choice !== null && choice >= 1 && choice <= poll.options.length) {
                tallies[choice - 1]++;
                totalVotes++;
            }
        }

        const results = {
            poll_id:     pollId,
            question:    poll.question,
            options:     poll.options.map((label, i) => ({ label, votes: tallies[i] })),
            total_votes: totalVotes,
            closed:      poll.expiresAt > 0 ? (Date.now() > poll.expiresAt) : false
        };

        console.log('Poll results:', JSON.stringify(results, null, 2));
    }

    /**
     * Lists all polls on the network.
     */
    async listPolls() {
        const count = await this.get('polls/count') ?? 0;
        const polls = [];

        for (let i = 1; i <= count; i++) {
            const poll = await this.get('poll/' + String(i));
            if (poll !== null) {
                const voteCount = await this.get('votes/count/' + String(i)) ?? 0;
                polls.push({
                    poll_id:     poll.id,
                    question:    poll.question,
                    total_votes: voteCount,
                    closed:      poll.expiresAt > 0 ? (Date.now() > poll.expiresAt) : false
                });
            }
        }

        console.log('All polls:', JSON.stringify(polls, null, 2));
    }
}

export default PollContract;