import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import { Coin, Denom, LCDClient, MnemonicKey, Msg, MsgExecuteContract, MsgSwap, Wallet } from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	COLLATERAL_DENOMS,
	columbus4,
	MARKET_DENOMS,
	tequila0004,
} from '@anchor-protocol/anchor.js'
import { Logger } from './Logger'

const MICRO_MULTIPLIER = 1_000_000

// TODO: See if we can make it dynamic
type Channels = { main: Msg[]; tgBot: Msg[] }
type ChannelName = keyof Channels

export class Bot {
	#running = false
	#walletDenom: any
	#config: Record<string, any>
	#cache: Map<string, Decimal> = new Map()
	#client: LCDClient
	#anchor: Anchor
	#wallet: Wallet
	#txChannels: Channels = { main: [], tgBot: [] }
	#addressProvider: AddressProviderFromJson

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
		this.#addressProvider = new AddressProviderFromJson(provider)
		this.#anchor = new Anchor(this.#client, this.#addressProvider)

		// Initialization of the user Wallet
		const key = new MnemonicKey({ mnemonic: this.#config.privateKey })
		this.#wallet = new Wallet(this.#client, key)

		this.#walletDenom = {
			address: this.#wallet.key.accAddress,
			market: Denom.USD,
		}

		Logger.log(dedent`<b>v0.2.5 - Anchor Borrow / Repay Bot</b>
				Made by Romain Lanz
				
				<b>Network:</b> <code>${this.#config.chainId === 'columbus-4' ? 'Mainnet' : 'Testnet'}</code>
				<b>Address:</b>
				<a href="https://finder.terra.money/${this.#config.chainId}/address/${this.#wallet.key.accAddress}">
					${this.#wallet.key.accAddress}
				</a>
				
				<u>Configuration:</u>
					- <b>SAFE:</b> <code>${this.#config.ltv.safe}%</code>
					- <b>LIMIT:</b> <code>${this.#config.ltv.limit}%</code>
					- <b>BORROW:</b> <code>${this.#config.ltv.borrow}%</code>
					- <b>SHOULD_BORROW_MORE:</b> <code>${this.#config.options.shouldBorrowMore}</code>
					- <b>MAX_FAILURE:</b> <code>${this.#config.options.maxFailure}</code>
		`)
	}

	set(path: string, value: string) {
		dset(this.#config, path, value)
	}

	async execute(goTo?: number, channelName: ChannelName = 'main') {
		if (this.#running) {
			if (channelName === 'tgBot') {
				Logger.log('Already running, please retry later.')
			}

			return
		}

		if (goTo) {
			if (goTo >= this.#config.ltv.limit) {
				Logger.log(`You cannot try to go over ${this.#config.ltv.limit}%`)
				return
			}

			if (goTo <= this.#config.ltv.borrow) {
				Logger.log(`You cannot try to go under ${this.#config.ltv.borrow}%`)
				return
			}
		}

		this.#running = true
		const ltv = await this.computeLTV()

		if (this.#config.options.shouldBorrowMore && +ltv.toFixed(3) < (goTo || this.#config.ltv.borrow)) {
			Logger.log(`LTV is at <code>${ltv.toFixed(3)}%</code>... borrowing...`)

			const amountToBorrow = await this.computeAmountToBorrow(goTo)
			this.toBroadcast(this.computeBorrowMessage(amountToBorrow), channelName)
			this.toBroadcast(this.computeDepositMessage(amountToBorrow), channelName)
			await this.broadcast(channelName)

			Logger.log(
				`Borrowed & Deposited <code>${amountToBorrow.toFixed(3)} UST</code>... LTV is now at <code>${
					goTo || this.#config.ltv.safe
				}%</code>`
			)
		}

		if (+ltv.toFixed(3) > (goTo || this.#config.ltv.limit)) {
			Logger.log(`LTV is at <code>${ltv.toFixed(3)}%</code>... repaying...`)

			const amountToRepay = await this.computeAmountToRepay(goTo)
			const walletBalance = await this.getUSTBalance()

			if (+walletBalance.minus(10) < +amountToRepay) {
				Logger.toBroadcast('Insufficient liquidity in your wallet... withdrawing...', channelName)

				const amountToWithdraw = amountToRepay.minus(walletBalance).plus(7)
				const depositAmount = await this.getDeposit()

				if (+depositAmount > +amountToWithdraw) {
					this.toBroadcast(this.computeWithdrawMessage(amountToWithdraw), channelName)
					Logger.toBroadcast(`Withdrawed <code>${amountToWithdraw.toFixed(3)} UST</code>...`, channelName)
				} else {
					Logger.toBroadcast('Insufficient deposit... trying to claim...', channelName)
					await this.executeClaimRewards()

					const ancBalance = await this.getANCBalance()
					const ancPrice = await this.getANCPrice()

					if (+ancPrice.times(ancBalance) > +amountToRepay) {
						const quantityToSell = amountToRepay.dividedBy(ancPrice)
						this.toBroadcast(this.computeSellANCMessage(quantityToSell), channelName)
						Logger.toBroadcast(
							`Sold <code>${quantityToSell.toFixed(3)} ANC</code> at <code>${ancPrice.toFixed(
								3
							)} UST</code> per ANC...`,
							channelName
						)

						const toStake = ancBalance.minus(quantityToSell)
						this.toBroadcast(this.computeStakeANCMessage(toStake), channelName)
						Logger.toBroadcast(`Staked <code>${toStake.toFixed(3)} ANC</code>...`, channelName)
					} else {
						Logger.toBroadcast(`Impossible to repay <code>${amountToRepay.toFixed(3)} UST</code>`, channelName)
						Logger.broadcast(channelName)
						this.#txChannels['main'] = []
						this.#running = false
						return
					}
				}
			}

			this.toBroadcast(this.computeRepayMessage(amountToRepay), channelName)
			await this.broadcast(channelName)

			Logger.toBroadcast(
				`Repaid <code>${amountToRepay.toFixed(3)} UST</code>... LTV is now at <code>${
					goTo || this.#config.ltv.safe
				}%</code>`,
				channelName
			)
			Logger.broadcast(channelName)
		}

		this.#running = false
	}

	// TODO: Need to do some debugging and refactoring once it works
	async compound() {
		this.#running = true

		Logger.log('Starting to compound...')

		await this.executeClaimRewards()

		const ancBalance = await this.getANCBalance()
		const ancPrice = await this.getANCPrice()

		Logger.toBroadcast(`ANC Balance ${ancBalance.toFixed(0)} @ ${ancPrice.toFixed(3)} UST`, 'tgBot')

		try {
			if (+ancBalance > 5) {
				await this.#anchor.anchorToken
					.sellANC(ancBalance.minus(1).toFixed(0))
					.execute(this.#wallet, { gasPrices: '0.15uusd' })

				const msg = new MsgSwap(
					this.#wallet.key.accAddress,
					new Coin(Denom.USD, ancBalance.times(ancPrice).times(MICRO_MULTIPLIER).toFixed(0)),
					Denom.LUNA
				)

				const tx = await this.#wallet.createAndSignTx({ msgs: [msg] })
				await this.#client.tx.broadcast(tx)

				Logger.toBroadcast(`Swapped ${ancBalance.times(ancPrice).toFixed(0)} UST for Luna`, 'tgBot')
			}

			const lunaBalance = await this.getLunaBalance()
			Logger.toBroadcast(`Luna Balance ${lunaBalance.toFixed(0)}`, 'tgBot')

			if (+lunaBalance > 5) {
				const msg = new MsgExecuteContract(
					this.#wallet.key.accAddress,
					'terra1fflas6wv4snv8lsda9knvq2w0cyt493r8puh2e',
					{
						bond: { validator: 'terravaloper1krj7amhhagjnyg2tkkuh6l0550y733jnjnnlzy' },
					},
					{ uluna: lunaBalance.times(MICRO_MULTIPLIER).toFixed(0) }
				)

				const tx = await this.#wallet.createAndSignTx({ msgs: [msg] })
				await this.#client.tx.broadcast(tx)
			}

			const { balance } = await this.#client.wasm.contractQuery<any>(this.#addressProvider.bLunaToken(), {
				balance: { address: this.#wallet.key.accAddress },
			})

			const bLunaBalance = new Decimal(balance).dividedBy(MICRO_MULTIPLIER)

			if (+bLunaBalance > 5) {
				await this.#anchor.borrow
					.provideCollateral({
						amount: bLunaBalance.minus(1).toFixed(0),
						collateral: COLLATERAL_DENOMS.UBLUNA,
						market: MARKET_DENOMS.UUSD,
					})
					.execute(this.#wallet, { gasPrices: '0.15uusd' })
			}

			Logger.toBroadcast(`Compouded... ${ancBalance.toFixed(3)} ANC => ${bLunaBalance.toFixed(3)} bLuna`, 'tgBot')
		} catch (e) {
			console.log(e.response.data)
		}

		Logger.broadcast('tgBot')
		this.#running = false
	}

	stopExecution() {
		this.#running = false
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

	async getLunaBalance(): Promise<Decimal> {
		const coins = await this.#client.bank.balance(this.#wallet.key.accAddress)
		const lunaCoin = coins.get(Denom.LUNA)

		if (!lunaCoin) {
			return new Decimal(0)
		}

		return lunaCoin.amount.dividedBy(MICRO_MULTIPLIER)
	}

	async computeLTV() {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()

		return borrowedValue.dividedBy(borrowLimit.times(2)).times(100)
	}

	async computeAmountToRepay(target = this.#config.ltv.safe) {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()
		const amountForSafeZone = new Decimal(target).times(borrowLimit.times(2).dividedBy(100))

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

	private toBroadcast(message: Msg | Msg[], channelName: ChannelName) {
		if (Array.isArray(message)) {
			this.#txChannels[channelName].push(...message)
			return
		}

		this.#txChannels[channelName].push(message)
	}

	clearQueue(channelName: ChannelName) {
		this.#txChannels[channelName] = []
	}

	private async broadcast(channelName: ChannelName) {
		try {
			const tx = await this.#wallet.createAndSignTx({ msgs: this.#txChannels[channelName] })
			await this.#client.tx.broadcast(tx)
		} catch (e) {
			Logger.log(`An error occured\n${e.response.data}`)
		} finally {
			this.#txChannels[channelName] = []
		}
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
