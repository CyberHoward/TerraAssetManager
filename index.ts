require('dotenv').config()
import got from 'got'
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
		got
			.post(`https://api.telegram.org/bot${BOT_API_KEY}/sendMessage`, {
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					chat_id: BOT_CHAT_ID,
					text: message,
					parse_mode: 'HTML',
				}),
			})
			.catch()
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

async function getDeposit() {
	const deposit = await anchor.earn.getTotalDeposit(walletDenom)
	return new Decimal(deposit)
}

async function getAncBalance() {
	const rewards = await anchor.anchorToken.getBalance(wallet.key.accAddress)
	return new Decimal(rewards)
}

async function getANCPrice() {
	const balance = await anchor.anchorToken.getANCPrice()
	return new Decimal(balance)
}

async function getAncStakedAmount() {
	const result = (await anchor.anchorToken.getStaker({ address: wallet.key.accAddress })) as Record<string, string>

	if ('balance' in result) {
		return new Decimal(result.balance).dividedBy(MICRO_MULTIPLIER)
	}

	return new Decimal(0)
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

log(`<b>v0.1 - Anchor Borrow / Repay Bot</b>
Made by Romain Lanz

<b>Network:</b> <code>${process.env.CHAIN_ID === 'columbus-4' ? 'Mainnet' : 'Testnet'}</code>
<b>Address:</b>
<a href="https://finder.terra.money/${process.env.CHAIN_ID}/address/${wallet.key.accAddress}">
	${wallet.key.accAddress}
</a>

<u>Configuration:</u>
  - <b>LTV_SAFE:</b> <code>${LTV_SAFE}%</code>
  - <b>LTV_LIMIT:</b> <code>${LTV_LIMIT}%</code>
  - <b>LTV_BORROW:</b> <code>${LTV_BORROW}%</code>
  - <b>SHOULD_BORROW_MORE:</b> <code>${SHOULD_BORROW_MORE}</code>
  - <b>MAX_FAILURE:</b> <code>${MAX_FAILURE}</code>
`)

let failure = 0
async function main() {
	try {
		const borrowedValue = await getBorrowedValue()
		const borrowedLimit = await getBorrowLimit()
		const LTV = getLTV(borrowedValue, borrowedLimit)

		if (SHOULD_BORROW_MORE && Number(LTV.toFixed(3)) < LTV_BORROW) {
			log(`LTV is under <code>${LTV.toFixed(3)}%</code>... borrowing...`)

			const amount = computeAmountToBorrow(borrowedValue, borrowedLimit)

			const borrowMessages = anchor.borrow
				.borrow({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
				.generateWithWallet(wallet)

			const depositMessages = anchor.earn
				.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
				.generateWithWallet(wallet)

			const tx = await wallet.createAndSignTx({ msgs: [...borrowMessages, ...depositMessages] })
			await client.tx.broadcast(tx)

			log(`Borrowed & Deposited <code>${amount.toFixed(3)} UST</code>... LTV is now at ${LTV_SAFE}%`)
		}

		if (Number(LTV.toFixed(3)) > LTV_LIMIT) {
			log(`LTV is higher than <code>${LTV.toFixed(3)}%</code>... repaying...`)

			const amount = computeAmountToRepay(borrowedValue, borrowedLimit)
			const balance = await getWalletBalance()
			let msgs = []
			let logMsgs = []

			if (balance.minus(10).toNumber() < amount.toNumber()) {
				logMsgs.push('Insufficient liquidity in your wallet... withdrawing...')

				const amountToWithdraw = amount.minus(balance).plus(7).toFixed(3)
				const depositAmount = await getDeposit()

				if (depositAmount.toNumber() > amount.toNumber()) {
					const withdrawMessage = anchor.earn
						.withdrawStable({ amount: amountToWithdraw, market: MARKET_DENOMS.UUSD })
						.generateWithWallet(wallet)

					msgs.push(...withdrawMessage)
					logMsgs.push(`Withdrawed <code>${amountToWithdraw} UST</code>...`)
				} else {
					logMsgs.push('Insufficient deposit... trying to claim...')
					await anchor.anchorToken.claimUSTBorrowRewards({ market: MARKET_DENOMS.UUSD }).execute(wallet, {})
					const ancBalance = await getAncBalance()
					const ancPrice = await getANCPrice()

					if (ancPrice.times(ancBalance).toNumber() > amount.toNumber()) {
						const quantityToSell = amount.dividedBy(ancPrice)
						const sellAncMessage = anchor.anchorToken.sellANC(quantityToSell.toFixed(3)).generateWithWallet(wallet)
						msgs.push(...sellAncMessage)
						logMsgs.push(
							`Sold <code>${quantityToSell.toFixed(3)} ANC</code> at <code>${ancPrice.toFixed(3)} UST</code> per ANC...`
						)

						const toStake = ancBalance.minus(quantityToSell)
						const stakeMessage = anchor.anchorToken
							.stakeVotingTokens({ amount: toStake.toFixed(3) })
							.generateWithWallet(wallet)
						msgs.push(...stakeMessage)
						logMsgs.push(`Staked <code>${toStake.toFixed(3)} ANC</code>...`)
					} else {
						// @see https://github.com/Anchor-Protocol/anchor.js/issues/22
						// logMsgs.push('Insufficient ANC balance... trying to unstake...')
						// const ancBalance = await getAncStakedAmount()

						// if (ancPrice.times(ancBalance).toNumber() > amount.toNumber()) {
						// 	const quantityToUnstake = amount.dividedBy(ancPrice)
						// } else {
						// logMsgs.push(`Insufficient staked ANC balance...`)
						logMsgs.push(`Impossible to repay <code>${amount.toFixed(3)} UST</code>`)
						log(logMsgs.join(CRLF))
						return
						// }
					}
				}
			}

			const borrowMessage = anchor.borrow
				.repay({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
				.generateWithWallet(wallet)

			const tx = await wallet.createAndSignTx({ msgs: [...msgs, ...borrowMessage] })
			await client.tx.broadcast(tx)

			logMsgs.push(`Repaid <code>${amount.toFixed(3)} UST</code>... LTV is now at <code>${LTV_SAFE}%</code>`)
			log(logMsgs.join(CRLF))
		}
	} catch (e) {
		log('An error occured')
		log(JSON.stringify(e.response?.data || e))
		failure++

		if (failure >= MAX_FAILURE) {
			log('Reaching max failure, exiting')
			process.exit(1)
		}
	}

	setTimeout(main, TIMING)
}

main()
