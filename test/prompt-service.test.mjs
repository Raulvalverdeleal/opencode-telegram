import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptService } from '../src/prompt-service.mjs';

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

test('replySplit sends Telegram-safe chunks', async () => {
	const sentMessages = [];
	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client: { session: {} },
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	const text = 'a'.repeat(5000);
	await service.replySplit(123, text);

	assert.equal(sentMessages.length, 2);
	assert.equal(sentMessages[0].chatId, 123);
	assert.equal(sentMessages[0].text.length, 3900);
	assert.equal(sentMessages[1].text.length, 1100);
});

test('promptWithPolling waits for idle and returns assistant text', async () => {
	let statusCalls = 0;
	let messagesCalls = 0;
	let promptBody;

	const client = {
		session: {
			messages: async () => {
				messagesCalls += 1;
				if (messagesCalls === 1) {
					return {
						data: [
							{
								info: { id: 'known-1', role: 'assistant', time: { created: 1 } },
								parts: [{ type: 'text', text: 'Old answer' }],
							},
						],
					};
				}
				return {
					data: [
						{
							info: { id: 'known-1', role: 'assistant', time: { created: 1 } },
							parts: [{ type: 'text', text: 'Old answer' }],
						},
						{
							info: { id: 'fresh-2', role: 'assistant', time: { created: 2 } },
							parts: [
								{ type: 'text', text: ' New answer ' },
								{ type: 'image', text: 'ignored' },
							],
						},
					],
				};
			},
			promptAsync: async ({ body }) => {
				promptBody = body;
			},
			status: async () => {
				statusCalls += 1;
				return {
					data: {
						session1: statusCalls < 2 ? { type: 'running' } : { type: 'idle' },
					},
				};
			},
		},
	};

	const service = createPromptService({
		bot: { telegram: { sendMessage: async () => {} } },
		client,
		modelConfig: () => ({ providerID: 'x', modelID: 'y' }),
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	const text = await service.promptWithPolling('session1', 'Hello server', 'trace-1');

	assert.equal(text, 'New answer');
	assert.equal(promptBody.parts[0].text, 'Hello server');
	assert.deepEqual(promptBody.model, { providerID: 'x', modelID: 'y' });
	assert.equal(statusCalls >= 2, true);
});

test('permission decision commands use pending request for chat', async () => {
	const sentMessages = [];
	const permissionReplies = [];

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'assistant-1', role: 'assistant', time: { created: 2 } },
						parts: [{ type: 'text', text: 'Ready' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({
				data: {
					session1: { type: 'idle' },
				},
			}),
		},
	};

	const interactionClient = {
		permission: {
			list: async () => ({
				data: [{ id: 'perm-1', sessionID: 'session1', permission: 'bash', patterns: [] }],
			}),
			reply: async input => {
				permissionReplies.push(input);
			},
		},
		question: {
			list: async () => ({ data: [] }),
			reply: async () => {},
			reject: async () => {},
		},
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	await service.promptWithPolling('session1', 'Need action', 'trace-2', 1001);
	const handled = await service.handleDecisionReply(1001, '/always');

	assert.equal(handled, true);
	assert.deepEqual(permissionReplies, [{ requestID: 'perm-1', reply: 'always' }]);
	assert.equal(
		sentMessages.some(item => item.text.includes('Responde con: /allow /reject /always')),
		true,
	);
});

test('question decision commands map numeric reply to option label', async () => {
	const questionReplies = [];

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'assistant-2', role: 'assistant', time: { created: 2 } },
						parts: [{ type: 'text', text: 'Ready' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({
				data: {
					session1: { type: 'idle' },
				},
			}),
		},
	};

	const interactionClient = {
		permission: {
			list: async () => ({ data: [] }),
			reply: async () => {},
		},
		question: {
			list: async () => ({
				data: [
					{
						id: 'q-1',
						sessionID: 'session1',
						questions: [
							{
								header: 'Choose one',
								question: 'Pick an option',
								options: [
									{ label: 'Option A', description: 'A' },
									{ label: 'Option B', description: 'B' },
								],
							},
						],
					},
				],
			}),
			reply: async input => {
				questionReplies.push(input);
			},
			reject: async () => {},
		},
	};

	const service = createPromptService({
		bot: { telegram: { sendMessage: async () => {} } },
		client,
		interactionClient,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	await service.promptWithPolling('session1', 'Need answer', 'trace-3', 2002);
	const handled = await service.handleDecisionReply(2002, '/2');

	assert.equal(handled, true);
	assert.deepEqual(questionReplies, [{ requestID: 'q-1', answers: [['Option B']] }]);
});

test('promptWithPolling uses SSE events when interaction client is available', async () => {
	const sentMessages = [];
	let statusCalls = 0;

	const client = {
		session: {
			messages: async () => {
				statusCalls += 1;
				if (statusCalls === 1) {
					return {
						data: [
							{
								info: { id: 'known-1', role: 'assistant', time: { created: 1 } },
								parts: [{ type: 'text', text: 'Old answer' }],
							},
						],
					};
				}
				return {
					data: [
						{
							info: { id: 'known-1', role: 'assistant', time: { created: 1 } },
							parts: [{ type: 'text', text: 'Old answer' }],
						},
						{
							info: { id: 'fresh-2', role: 'assistant', time: { created: 2 } },
							parts: [{ type: 'text', text: ' New answer from SSE ' }],
						},
					],
				};
			},
			promptAsync: async () => {},
			status: async () => ({
				data: {
					session1: { type: 'idle' },
				},
			}),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async () => ({
				stream: (async function* () {
					yield { type: 'session.status', properties: { sessionID: 'session1', status: { type: 'busy' } } };
					yield {
						type: 'message.part.updated',
						properties: {
							sessionID: 'session1',
							part: { id: 'tool-1', type: 'tool', tool: 'bash', state: { status: 'running' } },
						},
					};
					yield { type: 'session.idle', properties: { sessionID: 'session1' } };
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	const text = await service.promptWithPolling('session1', 'Hello with SSE', 'trace-sse', 999);

	assert.equal(text, 'New answer from SSE');
	assert.equal(
		sentMessages.some(item => item.text === 'Estado: busy'),
		true,
	);
	assert.equal(
		sentMessages.some(item => item.text.includes('Tool: bash (running)') || item.text === 'Estado: busy'),
		true,
	);
});

test('stopActive aborts in-flight prompt and marks stop error', async () => {
	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'known-1', role: 'assistant', time: { created: 1 } },
						parts: [{ type: 'text', text: 'Old answer' }],
					},
				],
			}),
			promptAsync: async () => {},
			abort: async () => {},
			status: async () => ({ data: {} }),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async ({ signal }) => ({
				stream: (async function* () {
					while (!signal.aborted) {
						await delay(5);
						yield { type: 'session.status', properties: { sessionID: 'session1', status: { type: 'busy' } } };
					}
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: { telegram: { sendMessage: async () => {} } },
		client,
		interactionClient,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 200,
		logInfo: () => {},
	});

	const running = service.promptWithPolling('session1', 'Please work', 'trace-stop', 4321);
	await delay(15);
	const stopped = await service.stopActive(4321);

	assert.equal(stopped, true);
	await assert.rejects(running, error => service.isStopError(error));
});

test('promptWithPolling skips progress messages when verbose is disabled', async () => {
	const sentMessages = [];

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'fresh-2', role: 'assistant', time: { created: 2 } },
						parts: [{ type: 'text', text: 'Final answer' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({ data: { session1: { type: 'idle' } } }),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async () => ({
				stream: (async function* () {
					yield { type: 'session.status', properties: { sessionID: 'session1', status: { type: 'busy' } } };
					yield { type: 'session.idle', properties: { sessionID: 'session1' } };
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		isVerboseEnabled: async () => false,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	const text = await service.promptWithPolling('session1', 'Hello', 'trace-v0', 77);
	assert.equal(text, 'Final answer');
	assert.equal(
		sentMessages.some(item => item.text.startsWith('Estado:')),
		false,
	);
});

test('promptWithPolling includes tool input details in verbose traces', async () => {
	const sentMessages = [];

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'fresh-3', role: 'assistant', time: { created: 3 } },
						parts: [{ type: 'text', text: 'Done' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({ data: { session1: { type: 'idle' } } }),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async () => ({
				stream: (async function* () {
					yield {
						type: 'message.part.updated',
						properties: {
							sessionID: 'session1',
							part: {
								id: 'tool-bash-1',
								type: 'tool',
								tool: 'bash',
								state: { status: 'running', input: { command: 'npm run test -- test/prompt-service.test.mjs' } },
							},
						},
					};
					yield { type: 'session.idle', properties: { sessionID: 'session1' } };
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		isVerboseEnabled: async () => true,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	await service.promptWithPolling('session1', 'Need detail', 'trace-v-detail', 55);

	assert.equal(
		sentMessages.some(item => item.text.includes('Tool: bash (running) - npm run test -- test/prompt-service.test.mjs')),
		true,
	);
});

test('promptWithPolling reads pending tool details from raw payload', async () => {
	const sentMessages = [];
	const patchRaw = JSON.stringify({
		patchText: ['*** Begin Patch', '*** Update File: src/a.mjs', '@@', '-x', '+y', '*** End Patch'].join('\n'),
	});

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'fresh-4', role: 'assistant', time: { created: 4 } },
						parts: [{ type: 'text', text: 'Done' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({ data: { session1: { type: 'idle' } } }),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async () => ({
				stream: (async function* () {
					yield {
						type: 'message.part.updated',
						properties: {
							sessionID: 'session1',
							part: {
								id: 'tool-ap-1',
								type: 'tool',
								tool: 'apply_patch',
								state: { status: 'pending', raw: patchRaw },
							},
						},
					};
					yield { type: 'session.idle', properties: { sessionID: 'session1' } };
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		isVerboseEnabled: async () => true,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	await service.promptWithPolling('session1', 'Need detail', 'trace-v-raw', 56);

	assert.equal(
		sentMessages.some(item => item.text.includes('Tool: apply_patch (pending) - src/a.mjs')),
		true,
	);
});

test('promptWithPolling does not throttle away tool details after status event', async () => {
	const sentMessages = [];

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'fresh-5', role: 'assistant', time: { created: 5 } },
						parts: [{ type: 'text', text: 'Done' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({ data: { session1: { type: 'idle' } } }),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async () => ({
				stream: (async function* () {
					yield { type: 'session.status', properties: { sessionID: 'session1', status: { type: 'busy' } } };
					yield {
						type: 'message.part.updated',
						properties: {
							sessionID: 'session1',
							part: {
								id: 'tool-read-1',
								type: 'tool',
								tool: 'read',
								state: { status: 'pending', input: { filePath: '/tmp/test.md' } },
							},
						},
					};
					yield { type: 'session.idle', properties: { sessionID: 'session1' } };
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		isVerboseEnabled: async () => true,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	await service.promptWithPolling('session1', 'Need detail', 'trace-v-throttle', 57);

	assert.equal(
		sentMessages.some(item => item.text.includes('Estado: busy')),
		true,
	);
	assert.equal(
		sentMessages.some(item => item.text.includes('Tool: read (pending) - /tmp/test.md')),
		true,
	);
});

test('promptWithPolling reads tool details from nested input in raw payload', async () => {
	const sentMessages = [];
	const raw = JSON.stringify({ input: { command: 'git status' } });

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'fresh-6', role: 'assistant', time: { created: 6 } },
						parts: [{ type: 'text', text: 'Done' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({ data: { session1: { type: 'idle' } } }),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async () => ({
				stream: (async function* () {
					yield {
						type: 'message.part.updated',
						properties: {
							sessionID: 'session1',
							part: {
								id: 'tool-bash-raw-1',
								type: 'tool',
								tool: 'bash',
								state: { status: 'pending', raw },
							},
						},
					};
					yield { type: 'session.idle', properties: { sessionID: 'session1' } };
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		isVerboseEnabled: async () => true,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	await service.promptWithPolling('session1', 'Need detail', 'trace-v-raw-input', 58);

	assert.equal(
		sentMessages.some(item => item.text.includes('Tool: bash (pending) - git status')),
		true,
	);
});

test('promptWithPolling emits updated detail for same tool status', async () => {
	const sentMessages = [];

	const client = {
		session: {
			messages: async () => ({
				data: [
					{
						info: { id: 'fresh-7', role: 'assistant', time: { created: 7 } },
						parts: [{ type: 'text', text: 'Done' }],
					},
				],
			}),
			promptAsync: async () => {},
			status: async () => ({ data: { session1: { type: 'idle' } } }),
		},
	};

	const interactionClient = {
		event: {
			subscribe: async () => ({
				stream: (async function* () {
					yield {
						type: 'message.part.updated',
						properties: {
							sessionID: 'session1',
							part: { id: 'tool-ap-2', type: 'tool', tool: 'apply_patch', state: { status: 'pending', input: {} } },
						},
					};
					yield {
						type: 'message.part.updated',
						properties: {
							sessionID: 'session1',
							part: {
								id: 'tool-ap-2',
								type: 'tool',
								tool: 'apply_patch',
								state: {
									status: 'pending',
									raw: JSON.stringify({ patchText: '*** Begin Patch\\n*** Update File: src/b.mjs\\n*** End Patch' }),
								},
							},
						},
					};
					yield { type: 'session.idle', properties: { sessionID: 'session1' } };
				})(),
			}),
		},
		permission: { list: async () => ({ data: [] }) },
		question: { list: async () => ({ data: [] }) },
	};

	const service = createPromptService({
		bot: {
			telegram: {
				sendMessage: async (chatId, text) => {
					sentMessages.push({ chatId, text });
				},
			},
		},
		client,
		interactionClient,
		isVerboseEnabled: async () => true,
		modelConfig: () => undefined,
		pollIntervalMs: 1,
		pollTimeoutMs: 100,
		logInfo: () => {},
	});

	await service.promptWithPolling('session1', 'Need detail', 'trace-v-same-status', 59);

	assert.equal(
		sentMessages.some(item => item.text === 'Tool: apply_patch (pending)'),
		true,
	);
	assert.equal(
		sentMessages.some(item => item.text.includes('Tool: apply_patch (pending) - src/b.mjs')),
		true,
	);
});
