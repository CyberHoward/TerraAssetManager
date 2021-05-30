import Decimal from 'decimal.js'
import { Denom, LCDClient, MnemonicKey, Msg, Wallet } from '@terra-money/terra.js'
import { AddressProviderFromJson, Anchor, columbus4, MARKET_DENOMS, tequila0004 } from '@anchor-protocol/anchor.js'
import { Logger } from './Logger'

const MICRO_MULTIPLIER = 1_000_000

export class Bot {
	#walletDenom: any
	#config: Record<string, any>
	#cache: Map<string, Decimal> = new Map()
	#client: LCDClient
	#anchor: Anchor
	#wallet: Wallet
	#txMessages: Msg[] = []

	constructor(config: any) {
		this.#config = config

		// Initialization of the Terra Client
		this.#client = new LCDClient({
			URL: this.#config.lcdUrl,
			chainID: this.#config.chainId,
			gasPrices: '0.15uusd',
		})

		// Initialization of the Anchor Client
		const provider = this.#config.chainId === 'columbus-4' ? columbus4 : tequila0004
		const addressProvider = new AddressProviderFromJson(provider)
		this.#anchor = new Anchor(this.#client, addressProvider)

		// Initialization of the user Wallet
		const key = new MnemonicKey({ mnemonic: this.#config.privateKey })
		this.#wallet = new Wallet(this.#client, key)

		this.#walletDenom = {
			address: this.#wallet.key.accAddress,
			market: Denom.USD,
		}
	}

	async execute() {
		const ltv = await this.computeLTV()

		if (this.#config.options.shouldBorrowMore && +ltv.toFixed(3) < this.#config.ltv.borrow) {
			Logger.log(`LTV is at <code>${ltv.toFixed(3)}%</code>... borrowing...`)

			const amountToBorrow = await this.computeAmountToBorrow()
			this.toBroadcast(this.computeBorrowMessage(amountToBorrow))
			this.toBroadcast(this.computeDepositMessage(amountToBorrow))
			await this.broadcast()

			Logger.log(
				`Borrowed & Deposited <code>${amountToBorrow.toFixed(3)} UST</code>... LTV is now at ${this.#config.ltv.safe}%`
			)
		}

		if (+ltv.toFixed(3) > this.#config.ltv.limit) {
			Logger.log(`LTV is at <code>${ltv.toFixed(3)}%</code>... repaying...`)

			const amountToRepay = await this.computeAmountToRepay()
			const walletBalance = await this.getUSTBalance()

			if (+walletBalance.minus(10) < +amountToRepay) {
				Logger.toBroadcast('Insufficient liquidity in your wallet... withdrawing...')

				const amountToWithdraw = amountToRepay.minus(walletBalance).plus(7)
				const depositAmount = await this.getDeposit()

				if (+depositAmount > +amountToWithdraw) {
					this.toBroadcast(this.computeWithdrawMessage(amountToWithdraw))
					Logger.toBroadcast(`Withdrawed <code>${amountToWithdraw.toFixed(3)} UST</code>...`)
				} else {
					Logger.toBroadcast('Insufficient deposit... trying to claim...')
					await this.executeClaimRewards()

					const ancBalance = await this.getANCBalance()
					const ancPrice = await this.getANCPrice()

					if (+ancPrice.times(ancBalance) > +amountToRepay) {
						const quantityToSell = amountToRepay.dividedBy(ancPrice)
						this.toBroadcast(this.computeSellANCMessage(quantityToSell))
						Logger.toBroadcast(
							`Sold <code>${quantityToSell.toFixed(3)} ANC</code> at <code>${ancPrice.toFixed(3)} UST</code> per ANC...`
						)

						const toStake = ancBalance.minus(quantityToSell)
						this.toBroadcast(this.computeStakeANCMessage(toStake))
						Logger.toBroadcast(`Staked <code>${toStake.toFixed(3)} ANC</code>...`)
					} else {
						Logger.toBroadcast(`Impossible to repay <code>${amountToRepay.toFixed(3)} UST</code>`)
						Logger.broadcast()
						this.#txMessages = []
						return
					}
				}
			}

			this.toBroadcast(this.computeRepayMessage(amountToRepay))
			await this.broadcast()

			Logger.toBroadcast(
				`Repaid <code>${amountToRepay.toFixed(3)} UST</code>... LTV is now at <code>${this.#config.ltv.safe}%</code>`
			)
			Logger.broadcast()
		}
	}

	clearCache() {
		this.#cache.clear()
	}

	async getUSTBalance(): Promise<Decimal> {
		const coins = await this.#client.bank.balance(this.#wallet.key.accAddress)
		const ustCoin = coins.get(Denom.USD)

		if (!ustCoin) {
			return new Decimal(0)
		}

		return ustCoin.amount.dividedBy(MICRO_MULTIPLIER)
	}

	async computeLTV() {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()

		return borrowedValue.dividedBy(borrowLimit.times(2)).times(100)
	}

	async computeAmountToRepay(safe = this.#config.ltv.safe) {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()
		const amountForSafeZone = new Decimal(safe).times(borrowLimit.times(2).dividedBy(100))

		return borrowedValue.minus(amountForSafeZone)
	}

	async computeAmountToBorrow(target = this.#config.ltv.safe) {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()

		return new Decimal(target).times(borrowLimit.times(2)).dividedBy(100).minus(borrowedValue)
	}

	getDeposit(): Promise<Decimal> {
		return this.cache('deposit', () => this.#anchor.earn.getTotalDeposit(this.#walletDenom))
	}

	getBorrowedValue(): Promise<Decimal> {
		return this.cache('borrowedValue', () => this.#anchor.borrow.getBorrowedValue(this.#walletDenom))
	}

	getBorrowLimit(): Promise<Decimal> {
		return this.cache('borrowLimit', () => this.#anchor.borrow.getBorrowLimit(this.#walletDenom))
	}

	getANCBalance(): Promise<Decimal> {
		return this.cache('ancBalance', () => this.#anchor.anchorToken.getBalance(this.#wallet.key.accAddress))
	}

	getANCPrice(): Promise<Decimal> {
		return this.cache('ancPrice', () => this.#anchor.anchorToken.getANCPrice())
	}

	computeBorrowMessage(amount: Decimal) {
		return this.#anchor.borrow
			.borrow({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeDepositMessage(amount: Decimal) {
		return this.#anchor.earn
			.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeWithdrawMessage(amount: Decimal) {
		return this.#anchor.earn
			.withdrawStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeRepayMessage(amount: Decimal) {
		return this.#anchor.borrow
			.repay({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

	computeSellANCMessage(amount: Decimal) {
		return this.#anchor.anchorToken.sellANC(amount.toFixed(3)).generateWithWallet(this.#wallet)
	}

	computeStakeANCMessage(amount: Decimal) {
		return this.#anchor.anchorToken.stakeVotingTokens({ amount: amount.toFixed(3) }).generateWithWallet(this.#wallet)
	}

	executeClaimRewards() {
		return this.#anchor.anchorToken.claimUSTBorrowRewards({ market: MARKET_DENOMS.UUSD }).execute(this.#wallet, {})
	}

	private toBroadcast(message: Msg | Msg[]) {
		if (Array.isArray(message)) {
			this.#txMessages.push(...message)
			return
		}
		this.#txMessages.push(message)
	}

	private async broadcast() {
		const tx = await this.#wallet.createAndSignTx({ msgs: this.#txMessages })
		await this.#client.tx.broadcast(tx)
		this.#txMessages = []
	}

	private async cache(key: string, callback: () => Promise<string>) {
		if (this.#cache.has(key)) {
			return this.#cache.get(key) as Decimal
		}

		const value = new Decimal(await callback())
		this.#cache.set(key, value)

		return value
	}
}
