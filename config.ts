export default {
	// This should be your wallet mnemonic (24 words).
	mnemonic: process.env.MNEMONIC,

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
		waitFor: 10,
	},

	ltv: {
		// This define the limit when the bot will repay your debt.
		limit: 50,

		// This define the safe-limit that the bot will reach when repaying or borrowing more.
		safe: 49,

		// This define the low-limit when the bot will borrow more.
		borrow: 48,
	},
	denom: 'uusd',
	LPs: ['mTSLA', 'mABNB', 'mBTC'],

	// Safety margin in percentage (liquidation LTV - max LTV) = 15%
	// example, TSLA mint is liquidated when LTV > 50% so with a 15% margin the script will repay some TSLA at 35% LTV
	mOCR: {
		limit: 10.5,

		safe: 11,

		borrow: 11.5,
	},

	// Max aUST/lentUST in %
	// When this margin is exceeded half of the deposits are used to farm MIR.
	maxDepositToLentRatio: 40,

	fractionToMirFarm: 10,

	notification: {
		tty: true,
		telegram: true,
	},
}
