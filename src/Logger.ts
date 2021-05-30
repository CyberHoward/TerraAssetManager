export class Logger {
	static messages: string[] = []

	static log(message: string) {
		console.log(message)
	}

	static toBroadcast(message: string) {
		Logger.messages.push(message)
	}

	static broadcast() {
		const messageToSend = Logger.messages.join('\n')
		console.log(messageToSend)
		Logger.messages = []
	}
}
