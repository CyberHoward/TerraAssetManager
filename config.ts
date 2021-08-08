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

	// DCP OCR is (minimum collateralisation ratio + mOCR), when mOCR goes below limit, bot repays in mAsset, when mOCR exceeds borrow, bot borrows more mAssets and LPs them.
	// example, TSLA short CDP is liquidated when OCR < 150% so with a 6% limit the script will repay some TSLA when OCR = 156% and bring the OCR to 162 (150 + safe(12)).
	mOCR: {
		limit: 6,

		safe: 12,

		borrow: 20,
	},

	// We want some aUST in anchor to handle LUNA volatility. Freeing up capital form MIR exposes us to a 1.5% CDP burn fee.  
	// When aUST depost value divided by UST depost value exceeds 40%, then 10% of borrowed value is used to farm on Mirror. 
	maxDepositToBorrowRatio: 40,

	fractionToMirFarm: 10,

	notification: {
		tty: true,
		telegram: true,
	},
}
