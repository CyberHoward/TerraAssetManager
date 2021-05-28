require('dotenv').config()
import got from 'got'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import { Denom, LCDClient, MnemonicKey, Wallet } from '@terra-money/terra.js'
import { AddressProviderFromJson, Anchor, columbus4, MARKET_DENOMS, tequila0004 } from '@anchor-protocol/anchor.js'

const MICRO_MULTIPLIER = 1_000_000

const MAX_FAILURE = Number(process.env.MAX_FAILURE) || 3
const TIMING = (Number(process.env.WAIT_FOR) || 10) * 1000
const TTY = Boolean(process.env.TTY) || false
const BOT_API_KEY = process.env.BOT_API_KEY
const BOT_CHAT_ID = process.env.BOT_CHAT_ID
const LTV_LIMIT = Number(process.env.LTV_LIMIT) || 43
const LTV_SAFE = Number(process.env.LTV_SAFE) || 35
const LTV_BORROW = Number(process.env.LTV_BORROW) || 30
const SHOULD_BORROW_MORE = Boolean(process.env.SHOULD_BORROW_MORE) || true
const CRLF = '\n'

const provider = process.env.CHAIN_ID === 'columbus-4' ? columbus4 : tequila0004

const addressProvider = new AddressProviderFromJson(provider)
const client = new LCDClient({
	URL: process.env.LCD_URL as string,
	chainID: process.env.CHAIN_ID as string,
	gasPrices: '0.15uusd',
})
const key = new MnemonicKey({ mnemonic: process.env.KEY })
const wallet = new Wallet(client, key)
const anchor = new Anchor(client, addressProvider)

const walletDenom = {
	address: wallet.key.accAddress,
	market: MARKET_DENOMS.UUSD,
}

function log(message: string) {
	if (TTY) {
		console.log(message)
	}

	if (BOT_API_KEY && BOT_CHAT_ID) {
		const encodedMessage = encodeURIComponent(message)

		got
			.post(`https://api.telegram.org/bot${BOT_API_KEY}/sendMessage?chat_id=${BOT_CHAT_ID}&text=${encodedMessage}`)
			.catch(() => {})
	}
}

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

function getLTV(borrowedValue: Decimal, borrowedLimit: Decimal) {
	return borrowedValue.dividedBy(borrowedLimit.times(2)).times(100)
}

function computeAmountToRepay(borrowedValue: Decimal, borrowedLimit: Decimal) {
	return borrowedValue.minus(new Decimal(LTV_SAFE).times(borrowedLimit.times(2)).dividedBy(100))
}

function computeAmountToBorrow(borrowedValue: Decimal, borrowedLimit: Decimal) {
	return new Decimal(LTV_SAFE).times(borrowedLimit.times(2)).dividedBy(100).minus(borrowedValue)
}

log(dedent`|-----------------------------------------------
	| Your are using the Anchor Borrow / Repay Bot
	|-----------------------------------------------
	| Version: 0.1
	| Made by Romain Lanz
	|
	| Network: ${process.env.CHAIN_ID === 'columbus-4' ? 'Mainnet' : 'Testnet'}
	| Address:
	| ${wallet.key.accAddress}
	|
	| Configuration:
	|  - LTV_SAFE: ${LTV_SAFE}%
	|  - LTV_LIMIT: ${LTV_LIMIT}%
	|  - LTV_BORROW: ${LTV_BORROW}%
	|  - SHOULD_BORROW_MORE: ${SHOULD_BORROW_MORE}
	|  - MAX_FAILURE: ${MAX_FAILURE}
	|
`)

let failure = 0
async function main() {
	try {
		const borrowedValue = await getBorrowedValue()
		const borrowedLimit = await getBorrowLimit()
		const LTV = getLTV(borrowedValue, borrowedLimit)

		if (SHOULD_BORROW_MORE && Number(LTV.toFixed(3)) < LTV_BORROW) {
			log(`LTV is under limit (${LTV.toFixed(3)}%)... borrowing...`)

			const amount = computeAmountToBorrow(borrowedValue, borrowedLimit)

			const borrowMessages = anchor.borrow
				.borrow({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
				.generateWithWallet(wallet)

			const depositMessages = anchor.earn
				.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
				.generateWithWallet(wallet)

			const tx = await wallet.createAndSignTx({ msgs: [...borrowMessages, ...depositMessages] })
			await client.tx.broadcast(tx)

			log(`Borrowed & Deposited ${amount.toFixed(3)} UST... LTV is now at ${LTV_SAFE}%`)
		}

		if (Number(LTV.toFixed(3)) > LTV_LIMIT) {
			log(`LTV is too high (${LTV.toFixed(3)}%)... repaying...`)

			const amount = computeAmountToRepay(borrowedValue, borrowedLimit)
			const balance = await getWalletBalance()
			let msgs = []
			let logMsgs = []

			if (balance.minus(10).toNumber() < amount.toNumber()) {
				logMsgs.push('Not enough liquidity in your wallet... withdrawing...')

				const amountToWithdraw = amount.minus(balance).plus(7).toFixed(3)
				const withdrawMessage = anchor.earn
					.withdrawStable({ amount: amountToWithdraw, market: MARKET_DENOMS.UUSD })
					.generateWithWallet(wallet)

				msgs.push(...withdrawMessage)
				logMsgs.push(`Withdrawed ${amountToWithdraw} UST...`)
			}

			const borrowMessage = anchor.borrow
				.repay({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
				.generateWithWallet(wallet)

			const tx = await wallet.createAndSignTx({ msgs: [...msgs, ...borrowMessage] })
			await client.tx.broadcast(tx)

			logMsgs.push(`Repaid ${amount.toFixed(3)} UST... LTV is now at ${LTV_SAFE}%`)
			log(logMsgs.join(CRLF))
		}
	} catch (e) {
		log('An error occured')
		log(JSON.stringify(e))
		failure++

		if (failure >= MAX_FAILURE) {
			log('Reaching max failure, exiting')
			process.exit(1)
		}
	}

	setTimeout(main, TIMING)
}

main()
