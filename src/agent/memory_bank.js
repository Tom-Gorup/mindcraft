export class MemoryBank {
	constructor() {
		this.memory = {};
		this.agent_memory = null;
	}

	// Wire up the long-term memory module: hydrates saved places from prior
	// sessions and mirrors new places into the event stream so they persist.
	attachMemory(agent_memory) {
		this.agent_memory = agent_memory;
		Object.assign(this.memory, agent_memory.getPlaces());
	}

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
		this.agent_memory?.recordPlace(name, x, y, z);
	}

	recallPlace(name) {
		return this.memory[name];
	}

	getJson() {
		return this.memory;
	}

	loadJson(json) {
		this.memory = json;
	}

	getKeys() {
		return Object.keys(this.memory).join(', ');
	}
}
