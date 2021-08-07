/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import { Denom, LCDClient, MnemonicKey, Msg, Wallet } from '@terra-money/terra.js'
import { AddressProviderFromJson, Anchor, columbus4, MARKET_DENOMS, tequila0004 } from '@anchor-protocol/anchor.js'
import {
	DEFAULT_TEQUILA_MIRROR_OPTIONS,
	DEFAULT_MIRROR_OPTIONS,
	Mirror,
	TerraswapToken,
} from '@mirror-protocol/mirror.js'
import { Logger } from './Logger'
import { CDP } from './CDP'
import { AnchorCDP } from './AnchorCDP'
const MICRO_MULTIPLIER = 1_000_000

// TODO: See if we can make it dynamic
type Channels = { main: Msg[]; tgBot: Msg[] }
type ChannelName = keyof Channels

function isBoolean(v: string | boolean | number) {
	return ['true', true, '1', 1, 'false', false, '0', 0].includes(v)
}

function toBoolean(v: string | boolean | number) {
	return ['true', true, '1', 1].includes(v)
}

type BotStatus = 'IDLE' | 'RUNNING' | 'PAUSE'

export class Bot {
	#failureCount = 0
	#walletDenom: { address: string; market: MARKET_DENOMS }
	#config: Record<string, any>
	#client: LCDClient
	#anchorCDP: AnchorCDP
	#cash: Decimal
	#savings: Decimal
	#mirror: Mirror
	#CDPs: CDP[] = []
	#wallet: Wallet
	#txChannels: Channels = { main: [], tgBot: [] }
	#status: BotStatus = 'IDLE'
	#addressProvider: AddressProviderFromJson
	#counter: number

	constructor(config: any) {
		this.#config = config
		this.#counter = 0
		// Initialization of the Terra Client
		this.#client = new LCDClient({
			URL: this.#config.lcdUrl,
			chainID: this.#config.chainId,
			gasPrices: '0.15uusd',
		})
		const key = new MnemonicKey({ mnemonic: this.#config.mnemonic })

		// Intialize Mirror Client
		const miroptions = this.#config.chainId === 'columbus-4' ? DEFAULT_MIRROR_OPTIONS : DEFAULT_TEQUILA_MIRROR_OPTIONS
		miroptions.lcd = this.#client
		miroptions.key = key

		this.#mirror = new Mirror(miroptions)

		this.#cash = new Decimal(0)
		this.#savings = new Decimal(0)

		// Initialization of the user Wallet
		this.#mirror.key = key
		this.#wallet = new Wallet(this.#client, key)
		this.#walletDenom = {
			address: this.#wallet.key.accAddress,
			market: this.#config.denom,
		}

		// Initialization of the Anchor CDP
		const provider = this.#config.chainId === 'columbus-4' ? columbus4 : tequila0004
		this.#addressProvider = new AddressProviderFromJson(provider)
		this.#anchorCDP = new AnchorCDP(
			new Anchor(this.#client, this.#addressProvider),
			this.#walletDenom,
			this.#config,
			this.#wallet
		)

		Logger.log(dedent`<b>v0.1 - Terra Yield Farming Bot</b>
				
				<b>Network:</b> <code>${this.#config.chainId === 'columbus-4' ? 'Mainnet' : 'Testnet'}</code>
				<b>Address:</b>
				<a href="https://finder.terra.money/${this.#config.chainId}/address/${this.#wallet.key.accAddress}">
					${this.#wallet.key.accAddress}
				</a>
				
				<u>Configuration:</u>
					- <b>SAFE:</b> <code>${this.#config.ltv.safe}%</code>
					- <b>LIMIT:</b> <code>${this.#config.ltv.limit}%</code>
					- <b>BORROW:</b> <code>${this.#config.ltv.borrow}%</code>
		`)
	}

	set(path: string, value: any): void {
		if (path === 'ltv.limit') {
			if (+value > 49) {
				Logger.log('You cannot go over <code>49</code>.')
				return
			}

			value = +value
		}

		if (path === 'ltv.safe') {
			if (+value >= this.#config.ltv.limit) {
				Logger.log(`You cannot go over <code>${this.#config.ltv.limit}</code>.`)
				return
			}

			value = +value
		}

		if (path === 'ltv.borrow') {
			if (+value >= this.#config.ltv.safe) {
				Logger.log(`You cannot go over <code>${this.#config.ltv.safe}</code>.`)
				return
			}

			value = +value
		}

		if (path === 'options.shouldBorrowMore') {
			if (!isBoolean(value)) {
				Logger.log(`The value must be a boolean (true/false).`)
				return
			}

			value = toBoolean(value)
		}

		dset(this.#config, path, value)
		Logger.log(`Configuration changed. <code>${path}</code> is now at <code>${value}</code>`)
	}

	run(): void {
		if (this.#status !== 'PAUSE') {
			Logger.log('Bot should be paused to run this command')
			return
		}

		this.#status = 'IDLE'
		Logger.log('Bot started')
	}

	pause(): void {
		this.#status = 'PAUSE'
		this.#failureCount = 0
		this.#counter = 0
		this.#CDPs = []
		this.clearQueue('main')
		this.clearQueue('tgBot')
		Logger.log('Bot paused')
	}

	async execute(goTo?: number, channelName: ChannelName = 'main'): Promise<void> {
		if (this.#status === 'PAUSE') {
			if (channelName === 'tgBot') {
				Logger.log('Bot is paused, use <code>/run</code> to start it.')
			}
			return
		}

		if (this.#status === 'RUNNING') {
			if (channelName === 'tgBot') {
				Logger.log('Already running, please retry later.')
			}

			if (this.#failureCount >= 5) {
				Logger.log('It seems that the bot is stuck! Restarting...')
				this.pause()
				setTimeout(() => this.run(), 1000)
			}

			this.#failureCount++
			return
		}

		if (this.#counter == 0) {
			await this.setCDPs()

			//await this.sleep(61000) // Wait at least 1 minute (oracle price update interval)
		} else if (this.#counter % 5 == 0) {
			//Check if there are claimable rewards and short positions.
		}

		await this.updateBalances()
		if (this.#cash.lessThan(100)) {
			await this.getSomeUST(100, channelName)
			await this.updateBalances()
		}
		await this.updateCDPs(channelName)
		this.#counter++
	}

	//What loans do I have?
	async setCDPs(): Promise<void> {
		const positions = (await this.#mirror.mint.getPositions(this.#wallet.key.accAddress)).positions

		for (const i in positions) {
			for (const j in this.#mirror.assets) {
				if (
					positions[i].asset.info.token.contract_addr === this.#mirror.assets[j].token.contractAddress &&
					(this.#config.LPs as string[]).includes(j)
				) {
					console.log(`Adding ${j} as CDP`)
					const l = this.#CDPs.push(
						new CDP(
							this.#mirror,
							positions[i].idx,
							this.#mirror.assets[j].symbol,
							this.#addressProvider.aTerra(),
							positions[i].is_short,
							'uusd'
						)
					)
					await this.#CDPs[l - 1].updateOpenMarketParam()
					await this.#CDPs[l - 1].setCDPTokenInfo()
					await this.#CDPs[l - 1].updateAndGetRelativeOCR()
					await this.#CDPs[l - 1].setPremium()
					
				}
			}
		}
		await this.#anchorCDP.setLTV()
		console.log('CDPs are set!')
	}

	//Check CDP OCR and correct if needed
	async updateCDPs(channelName: ChannelName): Promise<void> {
		// How is Anchor loan doing?
		await this.#anchorCDP.setLTV()
		await this.maintainAnchorCDP(channelName)

		// How are Mirror CDPs doing?
		for (const i in this.#CDPs) {
			this.#CDPs[i].setAssetAndCollateralAmount()
			const OCRmargin = (await this.#CDPs[i].updateAndGetRelativeOCR()) as Decimal
			console.log('OCR margin is: ' + OCRmargin)

			if (OCRmargin.lessThan(new Decimal(this.#config.mOCR.limit).dividedBy(100))) {
				await this.tryRepay(this.#CDPs[i], channelName)
				await this.updateBalances()
			} else if (OCRmargin.greaterThan(new Decimal(this.#config.mOCR.borrow).dividedBy(100))) {
				await this.shortMore(this.#CDPs[i], channelName)
				await this.updateBalances()
			}
		}

		// Enough deposits to farm on Mirror?
		if (
			this.#savings
				.dividedBy(this.#anchorCDP.lentValue)
				.greaterThan(new Decimal(this.#config.maxDepositToLentRatio).dividedBy(100))
		) {
			// Use fractionToMirFarm of deposits to increase MIR farm
			await this.useDepositsToFarm(channelName)
			await this.updateBalances()
		}
	}

	async tryRepay(mCDP: CDP, channelName: ChannelName): Promise<void> {
		try {
			//	How much mAsset is needed? 
			const repayAmount = await mCDP.getAssetAmountToCompensate(new Decimal(this.#config.mOCR.safe).dividedBy(100))
			console.log(`Need to repay ${repayAmount} of ${mCDP.assetName}`)

			// How much LP is needed to claim that amount? 
			const LPtoBurn = (
				await this.sufficientStaked(mCDP.assetAdress, repayAmount, mCDP.assetPrice.times(mCDP.premium))
			).floor()

			const collateralBalance = await this.getTokenBalance(mCDP.collateralName)
			const assetBalance = await this.getTokenBalance(mCDP.assetAdress)

			// Is asset currently tradeable? Otherwise adjusting CDP will fail
			if (mCDP.mintable) {

				if (LPtoBurn.greaterThan(new Decimal(0))) {
					// Enough long tokens staked to repay mCDP

					this.toBroadcast(mCDP.contructUnstakeMsg(LPtoBurn), channelName)
					this.toBroadcast(mCDP.constructUnbondMsg(LPtoBurn), channelName)
					this.toBroadcast(await mCDP.constructBurnMsg(repayAmount), channelName)

					console.log('broadcasting')
					await this.broadcast(channelName)
				} else if (assetBalance.dividedBy(MICRO_MULTIPLIER).greaterThanOrEqualTo(repayAmount)) {
					// Not enough long tokens staked to repay CDP, enough tokens in wallet?

					this.toBroadcast(await mCDP.constructBurnMsg(repayAmount), channelName)

					console.log('broadcasting')
					await this.broadcast(channelName)
				} else if (
					collateralBalance.dividedBy(MICRO_MULTIPLIER).greaterThanOrEqualTo(repayAmount.times(mCDP.assetPrice))
				) {
					// Enough aUST to repay?
					console.log('Repay with aUST')

					this.toBroadcast(mCDP.constructCollateralDepositMsg(repayAmount.times(mCDP.assetPrice)), channelName)
					await this.broadcast(channelName)
				}
			} else if (
				collateralBalance
					.dividedBy(MICRO_MULTIPLIER)
					.greaterThanOrEqualTo(repayAmount.times(mCDP.assetPrice).times(mCDP.minCollateralRatio))
			) {
				Logger.log('Repay with aUST, asset not mintable')

				this.toBroadcast(
					mCDP.constructCollateralDepositMsg(repayAmount.times(mCDP.assetPrice).times(mCDP.minCollateralRatio)),
					channelName
				)
				await this.broadcast(channelName)
			}
			await this.sleep(10000)
			await mCDP.setAssetAndCollateralAmount()
		} catch (err) {
			Logger.log(`Error in repaying CDP ${err}`)
		}
	}

	async getTokenBalance(collateralTokenAddress: string): Promise<Decimal> {
		const TSToken = new TerraswapToken({ contractAddress: collateralTokenAddress, lcd: this.#wallet.lcd })
		return new Decimal((await TSToken.getBalance(this.#wallet.key.accAddress)).balance)
	}

	async sufficientStaked(assetToken: string, mneeded: Decimal, onChainAssetPrice: Decimal): Promise<Decimal> {
		try {
			const pool = await this.#mirror.staking.getPoolInfo(assetToken)
			const LPs = (await this.#mirror.staking.getRewardInfo(this.#wallet.key.accAddress, assetToken)).reward_infos
			if (LPs) {
				// if there is an LP, check if it is short and get it's staked amount
				let LPStaked = new Decimal(0)
				for (const i in LPs) {
					if (!LPs[i].is_short) {
						LPStaked = new Decimal(LPs[i].bond_amount)
					}
				}
				const totalLP = new Decimal(pool.total_bond_amount)

				// Calculate LP amount to burn
				const LPToBurn = mneeded
					.times(totalLP)
					.dividedBy(totalLP.toPower(new Decimal(2)).dividedBy(onChainAssetPrice).sqrt())
					.times(MICRO_MULTIPLIER)
				// console.log(`want to burn ${LPToBurn} and i have ${LPStaked}`)
				if (LPToBurn.lessThanOrEqualTo(LPStaked)) {
					// Enough LP to repay
					return LPToBurn
				} else {
					// Not enough LP to repay
					console.log('returning 0')
					return new Decimal(0)
				}
			} else {
				// No LP found 
				return new Decimal(0)
			}
		} catch (err) {
			console.log('Error in getting pool information: ' + err)
			return new Decimal(0)
		}
	}

	async shortMore(mCDP: CDP, channelName: ChannelName): Promise<void> {
		// Get amount to short
		const shortAmount = (
			await mCDP.getAssetAmountToCompensate(new Decimal(this.#config.mOCR.safe).dividedBy(100))
		).abs()
		// Get needed UST to buy shortAmount of asset
		const neededSwapUST = (await mCDP.getOnchainReverseSim(shortAmount)).dividedBy(MICRO_MULTIPLIER) // How much UST do i need to buy the masset
		// How much UST needed for LP?
		const neededLPUST = shortAmount.times(mCDP.assetPrice).times(mCDP.premium)
		// How much UST needed in total? 
		const neededUST = neededLPUST.plus(neededSwapUST)
		console.log(`Lending and shorting ${shortAmount} more. I need ${neededUST} UST in total for the swap and LP'ing`)
		if (
			mCDP.mintable &&
			(this.#cash.greaterThan(neededUST.plus(10)) || this.#savings.greaterThan(neededUST.times(2)))
		) {
			// Need enough UST to buy and stake (x2) + some reserve for fees
			// We never want to totally deplete the anchor deposits 
			if (!this.#cash.greaterThan(neededUST)) {
				this.toBroadcast(this.#anchorCDP.computeWithdrawMessage(neededUST.dividedBy(mCDP.collateralPrice)), channelName)
			}
			this.toBroadcast(mCDP.constructMintMsg(shortAmount), channelName)
			this.toBroadcast(mCDP.constructBuyAndLPMsg(shortAmount, neededSwapUST, neededLPUST), channelName) //Stake if enough ust in wallet
			await this.broadcast(channelName)
			await mCDP.setAssetAndCollateralAmount()
		}
	}

	async maintainAnchorCDP(channelName: ChannelName): Promise<void> {
		if (this.#anchorCDP.LTV.greaterThan(this.#config.ltv.limit)) {
			const toRepay = await this.#anchorCDP.computeAmountToRepay()

			if (this.#cash.greaterThan(toRepay.plus(10))) {
				// Keep a little buffer for fees
				// Repay with cash

				this.toBroadcast(this.#anchorCDP.computeRepayMessage(toRepay), channelName)
				console.log(`Repaying Anchor with cash reserves`)
			} else if (this.#savings.greaterThan(toRepay)) {
				// Repay with deposits
				this.toBroadcast(
					this.#anchorCDP.computeWithdrawMessage(
						toRepay.dividedBy(
							(await this.#mirror.collateralOracle.getCollateralPrice(this.#addressProvider.aTerra())).rate
						)
					),
					channelName
				)
				this.toBroadcast(this.#anchorCDP.computeRepayMessage(toRepay), channelName)
				console.log(`Repaying Anchor with Anchor Deposits`)
			} else {
				//Try free up capital from Mirror farms
				console.log(`Repaying Anchor with UST from Mirror farms`)
				const cdp = await this.withdrawMirrorCapital(toRepay, channelName)
				this.toBroadcast(this.#anchorCDP.computeRepayMessage(toRepay), channelName)
				if (cdp != undefined) {
					cdp.setAssetAndCollateralAmount()
				}
			}
			console.log(`Broadcasting transactions`)
			await this.broadcast(channelName)
			await this.updateBalances()
		} else if (this.#anchorCDP.LTV.lessThan(this.#config.ltv.borrow)) {
			const toBorrow = await this.#anchorCDP.computeAmountToBorrow()
			console.log('Borrowing more')
			this.toBroadcast(this.#anchorCDP.computeBorrowMessage(toBorrow), channelName)
			this.toBroadcast(this.#anchorCDP.computeDepositMessage(toBorrow), channelName)
			console.log(`Broadcasting Anchor borrow and deposit transactions`)
			await this.broadcast(channelName)
			await this.updateBalances()
		}
	}

	async useDepositsToFarm(channelName: ChannelName): Promise<void> {
		console.log('We can use aUST for mir farm')
		const someCDP = this.#CDPs.find((cdp) => cdp.mintable && cdp.isShort)
		const usableCredit = new Decimal(this.#config.fractionToMirFarm / 100)
			.plus(
				this.#savings
					.dividedBy(this.#anchorCDP.lentValue)
					.minus(new Decimal(this.#config.maxDepositToLentRatio).dividedBy(100))
			)
			.times(this.#anchorCDP.lentValue)
		if (someCDP != undefined) {
			await someCDP.updateAssetAndCollateralPrice()
			await someCDP.setPremium()
			console.log(`Asset has a premium of ${someCDP.premium}`)

			const lentValue = someCDP.getLentValue()
			const collateralValue = someCDP.getCollateralValue()
			const CDPLTV = lentValue.dividedBy(collateralValue)

			const shortValue = CDPLTV.times(usableCredit.plus(collateralValue))
				.minus(lentValue)
				.dividedBy(new Decimal(2).times(someCDP.premium.times(CDPLTV)).plus(new Decimal(1)))
			console.log(`I will short massets worth ${shortValue}`)
			const neededaUST = lentValue.plus(shortValue).dividedBy(CDPLTV).minus(collateralValue) //((usableCredit.plus(lentValue)).minus(someCDP.premium.times(CDPLTV).times(2).times(collateralValue))).dividedBy(new Decimal(1).plus(someCDP.premium.times(2).times(CDPLTV)))
			const neededUST = shortValue.times(new Decimal(2).times(someCDP.premium)).times(1.005) //accounting for fees
			console.log(
				`credit of ${usableCredit.toFixed(0)} aUST/UST ${neededaUST.toFixed(0)}, ${neededUST.toFixed(
					0
				)} totaling ${neededUST.plus(neededaUST).toFixed(0)}`
			)

			//console.log(`Usable credit of ${usableCredit}, Lent value of ${lentValue} and collateral value of ${collateralValue} which results in a LTV of ${CDPLTV} with a needed aUST and UST of ${neededaUST}, ${neededUST} and a collateral price of ${someCDP.collateralPrice}`)
			this.toBroadcast(someCDP.constructCollateralDepositMsg(neededaUST), channelName)
			this.toBroadcast(
				this.#anchorCDP.computeWithdrawMessage(neededUST.dividedBy(someCDP.collateralPrice)),
				channelName
			)
			await this.broadcast(channelName)
			await someCDP.setAssetAndCollateralAmount()
			this.#cash = await this.getUSTBalance()
			this.#savings = await this.#anchorCDP.getDeposit()
			console.log('aUST is deposited and UST is made available for farming, now you can short more. ')
			await this.shortMore(someCDP, channelName)
		}
	}

	async withdrawMirrorCapital(neededUST: Decimal, channelName: ChannelName): Promise<CDP | undefined> {
		console.log(`Need ${neededUST} UST to repay Anchor`)
		const collateralValues = this.#CDPs.map((cdp) => {
			if (cdp.mintable) {
				return cdp.getCollateralValue().toNumber()
			} else {
				return 0
			}
		})
		if (collateralValues != undefined) {
			const biggestCDPidx = collateralValues.indexOf(Math.max(...collateralValues))
			const targetCDP = this.#CDPs[biggestCDPidx]
			await targetCDP.updateAssetAndCollateralPrice()
			await targetCDP.setAssetAndCollateralAmount()
			const lentValue = targetCDP.getLentValue()
			const collateralValue = targetCDP.getCollateralValue()
			const LTV = lentValue.dividedBy(collateralValue)
			// CDP collateral + lentValue ~ total vault value since long farm UST ~ lent value
			if (collateralValues[biggestCDPidx] != 0 && collateralValue.plus(lentValue).greaterThan(neededUST)) {
				await targetCDP.setPremium()
				const mAssetValueToBurn = LTV.times(neededUST.times(-1).plus(collateralValue))
					.minus(lentValue)
					.dividedBy(LTV.times(targetCDP.premium).plus(new Decimal(1)))
					.times(-1) // 1.5% Burn fee is drawn from collateral when closing position
				const mAssetToBurn = mAssetValueToBurn.dividedBy(targetCDP.assetPrice)

				const collateralWithdrawValue = lentValue.plus(mAssetValueToBurn).dividedBy(LTV).minus(collateralValue)
				const LPtoBurn = (
					await this.sufficientStaked(
						targetCDP.assetAdress,
						mAssetToBurn,
						targetCDP.assetPrice.times(targetCDP.premium)
					)
				).floor()
				console.log(
					`Need to burn ${mAssetValueToBurn} worth of assets and withdraw ${collateralWithdrawValue} for a total of ${mAssetToBurn
						.times(targetCDP.assetPrice.times(targetCDP.premium))
						.plus(collateralWithdrawValue)}, or ${neededUST} to get UST.
					With the the LP UST side being ${mAssetToBurn.times(targetCDP.assetPrice.times(targetCDP.premium))}.
					This is done with LP ${LPtoBurn}`
				)
				this.toBroadcast(targetCDP.contructUnstakeMsg(LPtoBurn), channelName)
				this.toBroadcast(targetCDP.constructUnbondMsg(LPtoBurn), channelName)
				this.toBroadcast(await targetCDP.constructBurnMsg(mAssetToBurn), channelName)
				this.toBroadcast(targetCDP.constructWithdrawMsg(collateralWithdrawValue), channelName)
				//await this.broadcast(channelName)

				this.toBroadcast(
					this.#anchorCDP.computeWithdrawMessage(collateralWithdrawValue.dividedBy(targetCDP.collateralPrice)),
					channelName
				) 
				
				return targetCDP
			}
		}
		return undefined
	}

	async updateBalances(): Promise<void> {
		this.#cash = await this.getUSTBalance()
		this.#savings = await this.#anchorCDP.getDeposit()
	}

	async getUSTBalance(): Promise<Decimal> {
		const coins = await this.#client.bank.balance(this.#wallet.key.accAddress)
		const ustCoin = coins.get(Denom.USD)

		if (!ustCoin) {
			return new Decimal(0)
		}

		return ustCoin.amount.dividedBy(MICRO_MULTIPLIER)
	}

	stopExecution(): void {
		this.#status = 'IDLE'
	}

	clearQueue(channelName: ChannelName): void {
		this.#txChannels[channelName] = []
	}

	private toBroadcast(message: Msg | Msg[], channelName: ChannelName) {
		if (Array.isArray(message)) {
			this.#txChannels[channelName].push(...message)
			return
		}

		this.#txChannels[channelName].push(message)
	}

	private async broadcast(channelName: ChannelName) {
		try {
			for (const j in this.#txChannels[channelName]) {
				console.log(this.#txChannels[channelName][j])
			}

			const tx = await this.#wallet.createAndSignTx({ msgs: this.#txChannels[channelName] })
			await this.#client.tx.broadcast(tx)
		} catch (e) {
			Logger.log(`An error occured\n${JSON.stringify(e.response.data)}`)
		} finally {
			this.#txChannels[channelName] = []
		}
	}

	
	async getSomeUST(amount: number, channelName: ChannelName) {
		if (this.#savings.greaterThan(amount)) {
			this.toBroadcast(this.#anchorCDP.computeWithdrawMessage(new Decimal(100)), channelName)
		} else {
			await this.withdrawMirrorCapital(new Decimal(amount), channelName)
		}
		await this.broadcast(channelName)
	}

	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}
}
