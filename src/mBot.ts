import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import { Coin, Coins, Denom, LCDClient, MnemonicKey, Msg, MsgExecuteContract, MsgSwap, StdFee, Wallet } from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	COLLATERAL_DENOMS,
	columbus4,
	MARKET_DENOMS,
	tequila0004,
} from '@anchor-protocol/anchor.js'
import {DEFAULT_TEQUILA_MIRROR_OPTIONS, DEFAULT_MIRROR_OPTIONS, Mirror, AssetInfo, Token, Asset, MirrorMint, AssetOptions, isNativeToken, TerraswapToken, } from '@mirror-protocol/mirror.js'
import { Logger } from './Logger'
import { CDP } from './CDP'

const MICRO_MULTIPLIER = 1_000_000

// TODO: See if we can make it dynamic
type Channels = { main: Msg[]; tgBot: Msg[] }
type ChannelName = keyof Channels

function isBoolean(v) {
	return ['true', true, '1', 1, 'false', false, '0', 0].includes(v)
}

function toBoolean(v) {
	return ['true', true, '1', 1].includes(v)
}

type BotStatus = 'IDLE' | 'RUNNING' | 'PAUSE';

export class Bot {
    #failureCount = 0
	#walletDenom: any
	#config: Record<string, any>
	#cache: Map<string, Decimal> = new Map()
	#client: LCDClient
    #anchor: Anchor
    #balance: Decimal
    #mirror: Mirror
	#CDPs: CDP [] = []
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
		this.#walletDenom = this.#config.denom

		// Initialization of the Anchor Client
		const provider = this.#config.chainId === 'columbus-4' ? columbus4 : tequila0004
		this.#addressProvider = new AddressProviderFromJson(provider)
		this.#anchor = new Anchor(this.#client, this.#addressProvider)

        // Intialize Mirror Client
        let miroptions = this.#config.chainId === 'columbus-4' ? DEFAULT_MIRROR_OPTIONS : DEFAULT_TEQUILA_MIRROR_OPTIONS
		miroptions.lcd = this.#client
		miroptions.key = key
        miroptions.collateralOracle = "terra1q3ls6u2glsazdeu7dxggk8d04elnvmsg0ung6n"
        this.#mirror = new Mirror(miroptions);
        
        // What mAsset pools do i want

		// Initialization of the user Wallet
		
		this.#mirror.key = key
		this.#wallet = new Wallet(this.#client, key)
		
		this.#walletDenom = {
			address: this.#wallet.key.accAddress,
			market: this.#config.denom
		}

        


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

	set(path: string, value: any) {
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

	run() {
		if (this.#status !== 'PAUSE') {
			Logger.log('Bot should be paused to run this command')
			return
		}

		this.#status = 'IDLE'
		Logger.log('Bot started')
	}

	pause() {
		this.#status = 'PAUSE'
		this.#failureCount = 0
		this.#counter = 0
		this.#CDPs = []
		this.clearCache()
		this.clearQueue('main')
		this.clearQueue('tgBot')
		Logger.log('Bot paused')
	}

    async execute(goTo?: number, channelName: ChannelName = 'main') {
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
        this.#balance = await this.getUSTBalance()
        Logger.log('Account has ' + this.#balance + 'UST.')

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
		if (this.#counter == 0){
			await this.setCDPs()
			this.#counter++
		}
		await this.updateCDPs(channelName);
		
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
    async setCDPs(){ 
        const positions = (await this.#mirror.mint.getPositions(this.#wallet.key.accAddress)).positions
		for (let i in positions){
			for (let j in this.#mirror.assets){
				if(positions[i].asset.info.token.contract_addr === this.#mirror.assets[j].token.contractAddress){
					let l = this.#CDPs.push(new CDP(this.#mirror, positions[i].idx,this.#mirror.assets[j].symbol,this.#addressProvider.aTerra(),positions[i].is_short, "uusd" ))
					await this.#CDPs[l-1].updateOpenMarketParam()
					await this.#CDPs[l-1].updateCDPTokenInfo()
				}
			}
		}
		console.log("CDPs are set!")
    }

	//Check CDP OCR and correct if needed
	async updateCDPs(channelName: ChannelName){
		for (let i in this.#CDPs){
			let OCRmargin = await this.#CDPs[i].updateAndGetRelativeOCR()
			console.log("OCR margin is: " + OCRmargin)
			if(OCRmargin.lessThan(new Decimal(this.#config.mOCR.limit).dividedBy(100))){
				await this.tryRepay(this.#CDPs[i], channelName)
			}else if (OCRmargin.greaterThan(new Decimal(this.#config.mOCR.borrow).dividedBy(100))) {
				console.log("ge kunt meer lenen jonghe! ")
			}
		}
	}

	async tryRepay(CDP: CDP, channelName: ChannelName){
		try{
			let repayAmount = (CDP.getAssetAmountToRepay(new Decimal(this.#config.mOCR.safe).dividedBy(100)))
			console.log(`Need to repay ${repayAmount} of mAsset`)
			let LPtoBurn = await this.sufficientStaked(CDP.assetAdress, repayAmount, CDP.assetPrice)
			let collateralBalance = await this.getCollateralBalance(CDP.collateralName)
			if (CDP.mintable) {
				if ((LPtoBurn != new Decimal(0)) ){ // Enough long tokens staked to repay CDP
					this.toBroadcast(await this.contructUnstakeMsg(CDP.assetAdress, LPtoBurn), channelName)
					this.toBroadcast(await this.constructUnbondMsg(CDP.assetName, LPtoBurn), channelName)
					this.toBroadcast(await this.constructBurnMsg(repayAmount, CDP.idx), channelName)
					console.log("broadcasting")
					await this.broadcast(channelName)
					await CDP.updateCDPTokenInfo()
				}else if (collateralBalance.greaterThanOrEqualTo(repayAmount.times(CDP.assetPrice).dividedBy(CDP.collateralPrice))){ // Not enough long tokens staked to repay CDP
					Logger.log("Genoeg massets om terug te betalen")
				}else {
					Logger.log('RIP')
				}
			} else {
				Logger.log('Repay with aUST')
			}
			
		} catch(err){
			Logger.log( `Error in repaying CDP ${err}`)
		}
	}
	
	async getCollateralBalance(collateralTokenAddress : string){
		const TSToken = new TerraswapToken({contractAddress: collateralTokenAddress, lcd : this.#wallet.lcd})
		const collBalance = new  Decimal((await TSToken.getBalance(this.#wallet.key.accAddress)).balance)
		return collBalance
	}

	async sufficientStaked(assetToken : string, needed : Decimal, assetPrice: Decimal){
		try{
			const pool = await this.getPoolInfo(assetToken)
			const LPs = (await this.#mirror.staking.getRewardInfo(this.#wallet.key.accAddress, assetToken)).reward_infos
			if (LPs){
				let LPStaked = new Decimal(0)
				for (let i in LPs){
					if(!LPs[i].is_short){
						LPStaked = new Decimal(LPs[i].bond_amount)
					}
				}
				const totalLP = new Decimal(pool.total_bond_amount)
				const LPToBurn = (needed.times(totalLP).dividedBy(((totalLP.toPower(new Decimal(2))).dividedBy(assetPrice)).sqrt())).times(MICRO_MULTIPLIER)

				if(LPToBurn.lessThanOrEqualTo(LPStaked)){
					return LPToBurn
				}else{
					return (new Decimal(0))
				}

			} else {
				return (new Decimal(0))
			}
			
		}catch(err){
			console.log("Error in getting pool information: " + err)
			return (new Decimal(0))
		}
	}

	

	async constructBurnMsg(mAssetToRepay: Decimal, positionID: string){
		let asset = (await this.#mirror.mint.getPosition(positionID)).asset;
		console.log(asset.amount)
		asset.amount = (mAssetToRepay.times(MICRO_MULTIPLIER)).toFixed(0).toString();
		console.log(asset.amount)
		return this.#mirror.mint.burn(positionID,asset)
	}

	async getPoolInfo(assetAdress: string){
		const poolinfo = await this.#mirror.staking.getPoolInfo(assetAdress)
		return poolinfo
	}


	async contructUnstakeMsg(assetToken: string, amount: Decimal){
		return this.#mirror.staking.unbond(assetToken,amount)
	}

	async constructUnbondMsg( tokenName: string, LP_token_amount: Decimal){
		const amount = LP_token_amount.toFixed(0).toString()
        console.log('Withdrawing '+tokenName+' LP...')
        return new MsgExecuteContract(
            this.#wallet.key.accAddress,
			this.#mirror.assets[tokenName].lpToken.contractAddress,
            {
                send:{
					amount: amount,
                    contract: this.#mirror.assets[tokenName].pair.contractAddress,
                    msg: "eyJ3aXRoZHJhd19saXF1aWRpdHkiOnt9fQ=="
                }
            },
            new Coins
        )
    }

	computeDepositMessage(amount: Decimal) {
		return this.#anchor.earn
			.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

    stopExecution() {
		this.#status = 'IDLE'
	}

	clearCache() {
		this.#cache.clear()
	}

    clearQueue(channelName: ChannelName) {
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
			console.log("Sending these transactions")
			console.log(this.#txChannels[channelName][0])
			const tx = await this.#wallet.createAndSignTx({ msgs: this.#txChannels[channelName] })
			await this.#client.tx.broadcast(tx)
		} catch (e) {
			Logger.log(`An error occured\n${JSON.stringify(e.response.data)}`)
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

		async executeMSG(msgs, type = 'else'){
			let fee = new StdFee(666666, '100000uusd')
			
			/*
			if(type == 'ANC'){
				fee = new StdFee(1000000, '250000uusd')
			}else if(type == 'repay'){
				let tax = await fetchAPI.tax_cap() //just use tax_cap
	
				fee = new StdFee(1000000, (250000 + tax).toString() + 'uusd') 
			}
			*/
			let isFound = false
			try{
				const tx = await this.#wallet.createAndSignTx({msgs, fee});
				const result = await this.#wallet.lcd.tx.broadcastSync(tx);       
				isFound = await this.pollingTx(result.txhash)
				if(isFound){
					console.log('Transaction Completed\n')
				}else{
					console.log('Transaction Fail, skip transaction')
				}
			}catch (err){
				console.log('Transaction Fail')
				await this.sleep(300)
				console.log(err)
			}
			this.sleep(6500)
		}

		async pollingTx(txHash) {
			let isFound = false;
			let count = 0; 
			while (!isFound && count < 5){ // to escape stuck
			  try {
				await this.#wallet.lcd.tx.txInfo(txHash);            
				isFound = true;
			  } catch (err) {
				await this.sleep(3000); 
				count += 1            
			  }
			}
			return isFound
		}

		sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

}