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
		waitFor: 45,
	},

	ltv: {
		// This define the limit when the bot will repay your debt.
		limit: 52,

		// This define the safe-limit that the bot will reach when repaying or borrowing more.
		safe: 45,

		// This define the low-limit when the bot will borrow more.
		borrow: 35,
	},
	denom: 'uusd',

	// The LPs you want the bot to handle
	LPs: ['mCOIN', 'mBTC', 'mSLV'],

	// Safety margin in percentage (liquidation LTV - max LTV) = 15%
	// example, TSLA mint is liquidated when LTV > 50% so with a 15% margin the script will repay some TSLA at 35% LTV
	mOCR: {
		limit: 6,

		safe: 12,

		borrow: 20,
	},

	// Max UST in anchor / lentUST in %
	// When this margin is exceeded fractionToMirFarm% of the deposits are used to increase MIR farming.
	maxDepositToLentRatio: 40,

	fractionToMirFarm: 10,

	notification: {
		tty: true,
		telegram: true,
	},
}
