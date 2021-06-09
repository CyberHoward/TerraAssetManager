export default {
	// This should be your wallet private key
	mnemonic: process.env.KEY || '',

	// This is Terra Blockchain information
	lcdUrl: process.env.LCD_URL,
	chainId: process.env.CHAIN_ID,

	// Telegram Bot information
	telegram: {
		apiKey: process.env.BOT_API_KEY,
		userId: process.env.BOT_CHAT_ID,
	},

	options: {
		// This define if the bot should borrow more
		shouldBorrowMore: true,

		// This define if the bot should use your reward to borrow more
		shouldCompoundsRewards: true,

		// This define the number of SECONDS to wait between each verification.
		waitFor: 15,

		// This define the number of uncaught issue the bot can have before shutting down, 0 = unlimited
		maxFailure: 3,
	},

	ltv: {
		// This define the limit when the bot will repay your debt.
		limit: 43,

		// This define the safe-limit that the bot will reach when repaying or borrowing more.
		safe: 35,

		// This define the low-limit when the bot will borrow more.
		borrow: 30,
	},

	notification: {
		tty: true,
		telegram: true,
	},
}
