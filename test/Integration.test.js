const { deployContracts } = require('../js/deployContracts')
const { expect } = require('chai')
const { increaseTime } = require('./helpers/increaseTime')
const { ethers } = require('./helpers/ethers')
const buidler = require('./helpers/buidler')
const { call } = require('./helpers/call')
const {
  PRIZE_POOL_INTERFACE_HASH,
  TICKET_INTERFACE_HASH,
  YIELD_SERVICE_INTERFACE_HASH,
  TIMELOCK_INTERFACE_HASH
} = require('../js/constants')

const toWei = ethers.utils.parseEther
const fromWei = ethers.utils.formatEther

const debug = require('debug')('ptv3:Integration.test')

describe('Integration Test', () => {
  
  let wallet, wallet2

  let env
  let token, token2
  let cToken

  let provider

  let prizePool
  let ticket, ticket2
  let interestTracker

  let overrides = { gasLimit: 40000000 }

  let prizePeriodSeconds = 10

  beforeEach(async () => {
    [wallet, wallet2] = await buidler.ethers.getSigners()
    provider = buidler.ethers.provider

    env = await deployContracts(wallet)
    token = env.token
    token2 = token.connect(wallet2)
    cToken = env.cToken

    let tx = await env.singleRandomWinnerPrizePoolBuilder.createSingleRandomWinnerPrizePool(cToken.address, prizePeriodSeconds, 'Ticket', 'TICK', 'Sponsorship', 'SPON', overrides)
    let receipt = await provider.getTransactionReceipt(tx.hash)
    let lastLog = receipt.logs[receipt.logs.length - 1]
    let singleRandomWinnerCreatedEvent = env.singleRandomWinnerPrizePoolBuilder.interface.events.SingleRandomWinnerPrizePoolCreated.decode(lastLog.data, lastLog.topics)

    debug({ singleRandomWinnerCreatedEvent })

    prizePool = await buidler.ethers.getContractAt('CompoundPeriodicPrizePool', singleRandomWinnerCreatedEvent.prizePool, wallet)
    prizePool2 = prizePool.connect(wallet2)
    ticket = await buidler.ethers.getContractAt('Ticket', await prizePool.ticket(), wallet)
    ticket2 = ticket.connect(wallet2)

    debug({
      ticket: ticket.address,
      ticket2: ticket2.address,
      tokenAddress: token.address
    })

    await token.mint(wallet._address, toWei('1000000'))
    await token.mint(wallet2._address, toWei('1000000'))
  })

  async function printGas(tx) {
    await tx.wait()
    let receipt = await provider.getTransactionReceipt(tx.hash)
    console.log(`Gas Used: ${receipt.gasUsed.toString()}`)
  }

  describe('Mint tickets', () => {
    it('should support timelocked withdrawals', async () => {
      debug('Approving token spend...')
      await token.approve(prizePool.address, toWei('100000'))
      await token2.approve(prizePool.address, toWei('100000'))

      debug('Minting tickets...')

      let tx, receipt

      await prizePool.mintTickets(wallet._address, toWei('100'), [], overrides)

      debug('Accrue custom...')

      await cToken.accrueCustom(toWei('22'))

      debug('First award...')

      await increaseTime(prizePeriodSeconds * 2)
      
      debug('starting award...')

      await prizePool.startAward()

      debug('completing award...')

      await prizePool.completeAward()

      debug('completed award')

      expect(await ticket.balanceOf(wallet._address)).to.equal(toWei('122'))
      let balanceBeforeWithdrawal = await token.balanceOf(wallet._address)

      debug('Redeem tickets with timelock...')

      await prizePool.redeemTicketsWithTimelock(toWei('122'), [])

      debug('Second award...')

      await increaseTime(prizePeriodSeconds * 2)
      await prizePool.startAward()
      await prizePool.completeAward()

      debug('Sweep timelocked funds...')

      await prizePool.sweep([wallet._address])

      let balanceAfterWithdrawal = await token.balanceOf(wallet._address)

      expect(balanceAfterWithdrawal.sub(balanceBeforeWithdrawal)).to.equal(toWei('122'))
    })

    it('should support instant redemption', async () => {
      debug('Minting tickets...')
      await token.approve(prizePool.address, toWei('100'))
      await prizePool.mintTickets(wallet._address, toWei('100'), [], overrides)

      debug('accruing...')

      await cToken.accrueCustom(toWei('22'))

      await increaseTime(4)

      let balanceBeforeWithdrawal = await token.balanceOf(wallet._address)
      
      debug('redeeming tickets...')

      await prizePool.redeemTicketsInstantly(toWei('100'), [])

      debug('checking balance...')

      let balanceAfterWithdrawal = await token.balanceOf(wallet._address)

      // no previous prize, so withdrawal costs zero
      expect(balanceAfterWithdrawal.sub(balanceBeforeWithdrawal)).to.equal(toWei('100'))
    })

    it('should take a fee when instantly redeeming after a prize', async () => {
      // first user has all the moola and is collateralized
      await token2.approve(prizePool.address, toWei('100'))

      debug('1.2')

      await prizePool2.mintTickets(wallet2._address, toWei('100'), [], overrides)

      debug('1.5')

      await cToken.accrueCustom(toWei('10'))

      await increaseTime(prizePeriodSeconds)

      debug('2')

      // second user has not collateralized
      await token.approve(prizePool.address, toWei('100'))
      await prizePool.mintTickets(wallet._address, toWei('100'), [], overrides)

      debug('3')

      await prizePool.startAward()
      await prizePool.completeAward()

      debug('4')

      // when second user withdraws, they must pay a fee
      let balanceBeforeWithdrawal = await token.balanceOf(wallet._address)

      await prizePool.redeemTicketsInstantly(toWei('100'), [])

      debug('5')

      let balanceAfterWithdrawal = await token.balanceOf(wallet._address)

      // no previous prize, so withdrawal costs zero
      let difference = balanceAfterWithdrawal.sub(balanceBeforeWithdrawal)

      console.log(fromWei(difference.toString()))

      expect(difference.lt(toWei('100'))).to.be.true
    })
  })
})