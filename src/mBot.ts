import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import {
	Coin,
	Coins,
	Dec,
	Denom,
	LCDClient,
	LocalTerra,
	MnemonicKey,
	Msg,
	MsgExecuteContract,
	MsgSwap,
	StdFee,
	Wallet,
} from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	COLLATERAL_DENOMS,
	columbus4,
	fabricateTerraswapProvideLiquidityANC,
	fabricateTerraswapProvideLiquiditybLuna,
	MARKET_DENOMS,
	tequila0004,
} from '@anchor-protocol/anchor.js'
import {
	DEFAULT_TEQUILA_MIRROR_OPTIONS,
	DEFAULT_MIRROR_OPTIONS,
	Mirror,
	AssetInfo,
	Token,
	Asset,
	MirrorMint,
	AssetOptions,
	isNativeToken,
	TerraswapToken,
	NativeToken,
	TerraswapPair,
	MirrorStaking,
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
	#walletDenom: {address: string, market: MARKET_DENOMS}
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
		miroptions.collateralOracle = 'terra1q3ls6u2glsazdeu7dxggk8d04elnvmsg0ung6n'
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

		Logger.log(dedent`<b>v0.2.6 - Anchor Borrow / Repay Bot</b>
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
		this.#cash = await this.getUSTBalance()
		this.#savings = await this.#anchorCDP.getDeposit()
		// Logger.log('Account has ' + this.#balance + 'UST.')

		/*
		if (this.#balance.greaterThan(new Decimal(1000))){
			this.toBroadcast(this.computeDepositMessage(new Decimal(1000)), channelName)
			Logger.log("Deposited 100 UST")
			await this.broadcast(channelName)
			Logger.toBroadcast('Testing', channelName)
		}
		*/

		//console.log(await this.#mirror.collaterallOracle.getCollateralAssetInfos())
		//console.log(this.#wallet)
		if (this.#counter == 0) {
			await this.setCDPs()
		}
		await this.updateCDPs(channelName)
		this.#counter++
	}

	async getUSTBalance(): Promise<Decimal> {
		const coins = await this.#client.bank.balance(this.#wallet.key.accAddress)
		const ustCoin = coins.get(Denom.USD)

		if (!ustCoin) {
			return new Decimal(0)
		}

		return ustCoin.amount.dividedBy(MICRO_MULTIPLIER)
	}

	//What loans do I have?
	async setCDPs(): Promise<void> {
		const positions = (await this.#mirror.mint.getPositions(this.#wallet.key.accAddress)).positions

		for (const i in positions) {
			for (const j in this.#mirror.assets) {
				if (positions[i].asset.info.token.contract_addr === this.#mirror.assets[j].token.contractAddress) {
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
					await this.#CDPs[l - 1].updateCDPTokenInfo()
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
		console.log(`Anchor LTV is ${this.#anchorCDP.LTV}%`)
		if((this.#anchorCDP.LTV).greaterThan(this.#config.ltv.limit)){
			const toRepay = await this.#anchorCDP.computeAmountToRepay()
			if(this.#cash.greaterThan(toRepay.plus(100))){ // Keep a little buffer for fees
				// Repay with cash 
				this.toBroadcast(this.#anchorCDP.computeRepayMessage(toRepay), channelName)
				console.log(`Repaying Anchor with cash reserves`)
				
			} else if (this.#savings.greaterThan(toRepay)){
				// Repay with deposits
				this.toBroadcast(this.#anchorCDP.computeWithdrawMessage(toRepay), channelName)
				this.toBroadcast(this.#anchorCDP.computeRepayMessage(toRepay), channelName)
				console.log(`Repaying Anchor with Anchor Deposits`)
			} else {
				//Try free up capital from Mirror farms
				this.toBroadcast(this.#anchorCDP.computeWithdrawMessage(toRepay), channelName)

				console.log(`Repaying Anchor with UST from Mirror farms`)
			}
			console.log(`Broadcasting Anchor repayment transactions`)
			await this.broadcast(channelName)
		} else if ((this.#anchorCDP.LTV).lessThan(this.#config.ltv.borrow)){
			const toBorrow = await this.#anchorCDP.computeAmountToBorrow()
			console.log('you can borrow more againt your luna')
			this.toBroadcast(this.#anchorCDP.computeBorrowMessage(toBorrow), channelName)
			this.toBroadcast(this.#anchorCDP.computeDepositMessage(toBorrow), channelName)
			console.log(`Broadcasting Anchor borrow and deposit transactions`)
			await this.broadcast(channelName)
		}

		// How are CDP's doing? 
		for (const i in this.#CDPs) {
			const OCRmargin = (await this.#CDPs[i].updateAndGetRelativeOCR()) as Decimal
			console.log('OCR margin is: ' + OCRmargin)

			if (OCRmargin.lessThan(new Decimal(this.#config.mOCR.limit).dividedBy(100))) {
				await this.tryRepay(this.#CDPs[i], channelName)
			} else if (OCRmargin.greaterThan(new Decimal(this.#config.mOCR.borrow).dividedBy(100))) {
				await this.shortMore(this.#CDPs[i], channelName)
			}

			//See if locked funds from shorting can be claimed
			// if((this.#counter > ((86400)/this.#config.options.waitFor)) || this.#counter == 0){
			// 	await this.#CDPs[i].tryClaimLockedFunds()
			// 	this.#counter = 1
			// }
		}

		// How much deposits do I have? 
		if (this.#savings.dividedBy(this.#anchorCDP.lentValue).greaterThan(new Decimal(this.#config.maxDepositToLentRatio).dividedBy(100))){
			// Use half of deposits to increase MIR farm
			// What pool? 
			
			const someCDP = this.#CDPs.find(cdp => cdp.mintable && cdp.isShort)
			const usableCredit = this.#savings.dividedBy(2)
			if(someCDP != undefined){
				someCDP.setPremium()
				someCDP.updateCDPTokenInfo()
				const lentValue = (new Decimal(someCDP.assetInfo.amount).times(someCDP.assetPrice)).dividedBy(MICRO_MULTIPLIER)
				const collateralValue = (new Decimal(someCDP.collateralInfo.amount).times(someCDP.collateralPrice)).dividedBy(MICRO_MULTIPLIER)
				const CDPLTV = lentValue.dividedBy(collateralValue)

				const neededaUST = ((usableCredit.plus(lentValue)).minus(someCDP.premium.times(CDPLTV).times(2).times(collateralValue))).dividedBy(new Decimal(1).plus(someCDP.premium.times(2).times(CDPLTV)))
				const neededUST = usableCredit.minus(neededaUST)
				this.toBroadcast(this.#anchorCDP.computeWithdrawMessage(neededUST), channelName)

				console.log(`Usable credit of ${usableCredit}, Lent value of ${lentValue} and collateral value of ${collateralValue} which results in a LTV of ${CDPLTV} with a needed aUST and UST of ${neededaUST}, ${neededUST}`)
				const shortValue = CDPLTV.times(collateralValue.minus(neededaUST))
				this.toBroadcast(someCDP.constructCollateralDepositMsg(neededaUST.dividedBy(someCDP.collateralPrice)), channelName)
				this.toBroadcast(someCDP.constructMintMsg(shortValue.dividedBy(someCDP.assetPrice) ), channelName)
				this.toBroadcast(someCDP.constructBuyAndLPMsg(shortValue.dividedBy(someCDP.assetPrice),neededUST.dividedBy(2)), channelName)
				
				
				this.broadcast(channelName)
			}
		}

	}

	async tryRepay(mCDP: CDP, channelName: ChannelName): Promise<void> {
		try {
			const repayAmount = mCDP.getAssetAmountToCompensate(new Decimal(this.#config.mOCR.safe).dividedBy(100))
			console.log(`Need to repay ${repayAmount} of ${mCDP.assetName}`)
			const LPtoBurn = (await this.sufficientStaked(mCDP.assetAdress, repayAmount, mCDP.assetPrice)).floor()
			const collateralBalance = await this.getTokenBalance(mCDP.collateralName)
			const assetBalance = await this.getTokenBalance(mCDP.assetAdress)

			if (mCDP.mintable) {
				if (LPtoBurn.greaterThan(new Decimal(0))) {
					// Enough long tokens staked to repay mCDP

					this.toBroadcast(mCDP.contructUnstakeMsg(LPtoBurn), channelName)
					this.toBroadcast(mCDP.constructUnbondMsg(LPtoBurn), channelName)
					this.toBroadcast(await mCDP.constructBurnMsg(repayAmount), channelName)

					// TODO: if high premium is present, this will fail since the mAsset received will be less then expected
					//Solution: replace price with on-chain asset price
					console.log('broadcasting')
					await this.broadcast(channelName)

					await mCDP.updateCDPTokenInfo()
				} else if (assetBalance.greaterThanOrEqualTo(repayAmount)) {
					// Not enough long tokens staked to repay CDP, enough tokens in wallet?
					Logger.log('Genoeg massets om terug te betalen')

					this.toBroadcast(await mCDP.constructBurnMsg(repayAmount), channelName)

					console.log('broadcasting')
					await this.broadcast(channelName)
					await mCDP.updateCDPTokenInfo()
				} else if (
					collateralBalance.dividedBy(MICRO_MULTIPLIER).greaterThanOrEqualTo(repayAmount.times(mCDP.assetPrice))
				) {
					Logger.log('Repay with aUST')

					this.toBroadcast(mCDP.constructCollateralDepositMsg(repayAmount.times(mCDP.assetPrice)), channelName)
					await this.broadcast(channelName)
					await mCDP.updateCDPTokenInfo()
				}
			} else if (
				collateralBalance
					.dividedBy(MICRO_MULTIPLIER)
					.greaterThanOrEqualTo(repayAmount.times(mCDP.assetPrice).times(mCDP.minCollateralRatio))
			) {
				Logger.log('Repay with aUST, asset not mintable')

				this.toBroadcast(mCDP.constructCollateralDepositMsg(repayAmount.times(mCDP.assetPrice)), channelName)
				await this.broadcast(channelName)
				await mCDP.updateCDPTokenInfo()
			}
		} catch (err) {
			Logger.log(`Error in repaying CDP ${err}`)
		}
	}

	async getTokenBalance(collateralTokenAddress: string): Promise<Decimal> {
		const TSToken = new TerraswapToken({ contractAddress: collateralTokenAddress, lcd: this.#wallet.lcd })
		return new Decimal((await TSToken.getBalance(this.#wallet.key.accAddress)).balance)
	}

	async sufficientStaked(assetToken: string, needed: Decimal, oracleAssetPrice: Decimal): Promise<Decimal> {
		try {
			const pool = await this.#mirror.staking.getPoolInfo(assetToken)
			const LPs = (await this.#mirror.staking.getRewardInfo(this.#wallet.key.accAddress, assetToken)).reward_infos
			const assetPrice = oracleAssetPrice.times(new Decimal(1).plus(pool.premium_rate))
			if (LPs) {
				let LPStaked = new Decimal(0)
				for (const i in LPs) {
					if (!LPs[i].is_short) {
						LPStaked = new Decimal(LPs[i].bond_amount)
					}
				}
				const totalLP = new Decimal(pool.total_bond_amount)
				const LPToBurn = needed
					.times(totalLP)
					.dividedBy(totalLP.toPower(new Decimal(2)).dividedBy(assetPrice).sqrt())
					.times(MICRO_MULTIPLIER)
				// console.log(`want to burn ${LPToBurn} and i have ${LPStaked}`)
				if (LPToBurn.lessThanOrEqualTo(LPStaked)) {
					return LPToBurn
				} else {
					console.log('returning 0')
					return new Decimal(0)
				}
			} else {
				return new Decimal(0)
			}
		} catch (err) {
			console.log('Error in getting pool information: ' + err)
			return new Decimal(0)
		}
	}

	async shortMore(mCDP: CDP, channelName: ChannelName): Promise<void> {
		const shortAmount = mCDP.getAssetAmountToCompensate(new Decimal(this.#config.mOCR.safe).dividedBy(100)).abs()
		const neededUST = (await mCDP.getOnchainReverseSim(shortAmount)).dividedBy(MICRO_MULTIPLIER) // How much UST do i need to buy the masset
		
		if (mCDP.mintable && this.#cash.greaterThan(neededUST.times(2.1))) { // Need enough UST to buy and stake (x2) + some reserve for fees
			this.toBroadcast(mCDP.constructMintMsg(shortAmount), channelName)
			this.toBroadcast(mCDP.constructBuyAndLPMsg(shortAmount, neededUST), channelName) //Stake if enough ust in wallet
			await this.broadcast(channelName)
			await mCDP.updateCDPTokenInfo()
		}
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
			// console.log("Sending these transactions")
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

	async getLunaBalance(): Promise<Decimal> {
		const coins = await this.#client.bank.balance(this.#wallet.key.accAddress)
		const lunaCoin = coins.get(Denom.LUNA)

		if (!lunaCoin) {
			return new Decimal(0)
		}

		return lunaCoin.amount.dividedBy(MICRO_MULTIPLIER)
	}

	/*
	computeOpenPositionMessage(camount: Decimal, asset_name: string, margin = this.#config.mOCR.limit){
		const asset_info: Token = {
			token:{
				contract_addr: this.#massets.get(asset_name)[0].token,
			}
		};
		const aUSTtoken: Token = {
			token:{
				contract_addr: this.#addressProvider.aTerra(),
			}
		};
		const aUSTAsset: Asset<AssetInfo> = {
			info: aUSTtoken,
			amount: camount.times(new Decimal(MICRO_MULTIPLIER)).floor().toString()
		}
			// NOG AANPASSEN 
		let ratio = new Decimal(margin).dividedBy(100).add(new Decimal(1.5)).toFixed(3);
		
		

		const open: MirrorMint.HandleOpenPosition = {
			open_position: {
				collateral: aUSTAsset,
				asset_info: asset_info,
				collateral_ratio: ratio.toString(),
				
			}
		}
		
		let exMsg = new MsgExecuteContract(
			this.#wallet.key.accAddress,
			this.#addressProvider.aTerra(),
			{
				send:{
					contract: this.#mirror.mint.contractAddress,
					amount: (camount.times(new Decimal(MICRO_MULTIPLIER))).toFixed(0).toString(),
					msg: open,
				}
			},
			new Coins
		)
		return [exMsg]
		} */

	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}
}
