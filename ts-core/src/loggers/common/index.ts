import pino from "pino";

const transport = pino.transport({
	targets: [
		{
			level: "trace",
			target: "pino-pretty",
		},
		// {
		//     target: 'pino-socket',
		//     options: {
		//         address: '127.0.0.1',
		//         port: 9000,
		//         mode: 'tcp',
		//         reconnect: true,
		//     },
		// }
	],
});

export const Loggers = {
	// We use the transport for high-performance non-blocking logs
	logger: pino(transport),
};

(globalThis as typeof globalThis & { logger?: typeof Loggers.logger }).logger =
	Loggers.logger;
