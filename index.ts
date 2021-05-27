require('dotenv').config()
import Decimal from 'decimal.js'
import { Denom, LCDClient, MarketAPI, MnemonicKey, Wallet } from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	columbus4,
	MARKET_DENOMS,
	OperationGasParameters,
	tequila0004,
} from '@anchor-protocol/anchor.js'

const TIMING = 10 * 1000
const MICRO_MULTIPLIER = 1_000_000
const LTV_LIMIT = Number(process.env.LTV_LIMIT) || 40
const LTV_SAFE = Number(process.env.LTV_SAFE) || 35
const LTV_BORROW = Number(process.env.LTV_BORROW) || 25

const provider = process.env.CHAIN_ID === 'columbus-4' ? columbus4 : tequila0004
const addressProvider = new AddressProviderFromJson(provider)
const client = new LCDClient({ URL: process.env.LCD_URL as string, chainID: process.env.CHAIN_ID as string })
const key = new MnemonicKey({ mnemonic: process.env.KEY })
const wallet = new Wallet(client, key)
const anchor = new Anchor(client, addressProvider)
const gasParameters: OperationGasParameters = {
	gasAdjustment: 1.4,
	gasPrices: '0.15uusd',
}
const walletDenom = {
	address: wallet.key.accAddress,
	market: MARKET_DENOMS.UUSD,
}

// function getDeposit() {
// 	return anchor.earn.getTotalDeposit(walletDenom)
// }

// function sleep(ms: number) {
// 	return new Promise((resolve) => setTimeout(resolve, ms))
// }

async function getWalletBalance() {
	const balance = (await client.bank.balance(wallet.key.accAddress)).get(Denom.USD)

	if (!balance) {
		return new Decimal(0)
	}

	return balance.amount.dividedBy(MICRO_MULTIPLIER)
}

async function getBorrowedValue() {
	const borrowedValue = await anchor.borrow.getBorrowedValue(walletDenom)
	return new Decimal(borrowedValue)
}

async function getBorrowLimit() {
	const borrowedLimit = await anchor.borrow.getBorrowLimit(walletDenom)
	return new Decimal(borrowedLimit)
}

async function getLTV(borrowedValue: Decimal, borrowedLimit: Decimal) {
	return borrowedValue.dividedBy(borrowedLimit.times(2)).times(100)
}

function computeRepayAmount(borrowedValue: Decimal, borrowedLimit: Decimal) {
	return borrowedValue.minus(new Decimal(LTV_SAFE).times(borrowedLimit.times(2)).dividedBy(100))
}

function computeBorrowAmount(borrowedValue: Decimal, borrowedLimit: Decimal) {
	return new Decimal(LTV_SAFE).times(borrowedLimit.times(2)).dividedBy(100).minus(borrowedValue)
}

async function main() {
	// const deposit = await getDeposit()

	// if (Number(deposit) < 1) {
	// 	console.log('Deposit amount is too small to be used.')
	// 	process.exit(1)
	// }

	const borrowedValue = await getBorrowedValue()
	const borrowedLimit = await getBorrowLimit()
	const LTV = await getLTV(borrowedValue, borrowedLimit)

	if (Number(LTV.toFixed(3)) < LTV_BORROW) {
		console.log(`TVL is low (${LTV.toFixed(3)}%)`)
		console.log('Borrowing...')

		const amount = computeBorrowAmount(borrowedValue, borrowedLimit)
		await anchor.borrow.borrow({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD }).execute(wallet, gasParameters)
		console.log(`Borrowed ${amount.toFixed(3)} UST... TVL is now at ${LTV_SAFE}%`)

		await anchor.earn
			.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.execute(wallet, gasParameters)
		console.log(`Deposited ${amount.toFixed(3)} UST...`)
	}

	if (Number(LTV.toFixed(3)) > LTV_LIMIT) {
		console.log(`TVL is too high (${LTV.toFixed(3)}%)`)
		console.log('Repaying...')

		const amount = computeRepayAmount(borrowedValue, borrowedLimit)
		const balance = await getWalletBalance()

		if (balance.toNumber() < amount.toNumber()) {
			console.log('Not enough in your wallet... withdrawing...')
			const amountToWithdraw = amount.minus(balance).plus(5).toFixed(3)
			await anchor.earn
				.withdrawStable({ amount: amountToWithdraw, market: MARKET_DENOMS.UUSD })
				.execute(wallet, gasParameters)

			console.log(`Withdrawed ${amountToWithdraw} UST...`)
		}

		await anchor.borrow.repay({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD }).execute(wallet, gasParameters)
		console.log(`Repayed ${amount.toFixed(3)} UST... TVL is now at ${LTV_SAFE}%`)
	}

	setTimeout(main, TIMING)
}

main()
