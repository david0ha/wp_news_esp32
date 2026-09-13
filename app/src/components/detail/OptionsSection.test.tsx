import { jest, it, expect } from '@jest/globals'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { OptionsSection } from './OptionsSection'
import { OptionChainRow } from '../OptionChainRow'
import { Chip } from '../Chip'
// Expo lazily transforms native view modules during the first asynchronous render.
jest.setTimeout(15000)
jest.mock('../../lib/market/alpaca', () => ({ alpacaOptions: jest.fn() }))
jest.mock('../../lib/market/yahoo', () => ({ yahoo: { options: jest.fn() } }))
const api = require('../../lib/market/alpaca').alpacaOptions
const contract = (strike: number) => ({strike, bid: 2, ask: 3, lastPrice: 2.4, delta: .5, gamma: .03, volume: null, openInterest: null, impliedVolatility: .3, inTheMoney: false, multiplier: 100})
const chain = {symbol:'TEST',spot:100,expiration:1800000000,expirationDates:[1800000000,1800600000],calls:[contract(100),contract(110)],puts:[contract(100)],source:'alpaca',feed:'indicative'}
it('shows premiums and Greeks and opens detail after two spread strikes', async () => {
 api.mockResolvedValue(chain)
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 expect(api).toHaveBeenCalled()
 expect(tree!.root.findAllByType(OptionChainRow)).toHaveLength(2)
 expect(JSON.stringify(tree!.toJSON())).toContain('3.00')
 expect(JSON.stringify(tree!.toJSON())).toContain('0.0300')
 const tabs = tree!.root.findAllByType(Chip)
 await act(async () => tabs.find(c => c.props.label === 'Long call spread')!.props.onPress())
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 expect(JSON.stringify(tree!.toJSON())).not.toContain('Maximum profit')
 await act(async () => tree!.root.findAllByType(OptionChainRow)[1].props.onPress())
 expect(JSON.stringify(tree!.toJSON())).toContain('Maximum profit')
 act(() => tree!.unmount())
})
it('refetches on symbol change and ignores an old response', async () => {
 let resolveOld: (c: typeof chain) => void = () => {}
 api.mockImplementationOnce(() => new Promise(resolve => {resolveOld = resolve})).mockResolvedValueOnce({...chain,symbol:'NEW',calls:[contract(200)]})
 let tree: ReturnType<typeof create>
 await act(async () => {tree = create(<OptionsSection symbol="OLD" active />)})
 await act(async () => tree!.update(<OptionsSection symbol="NEW" active />))
 await act(async () => resolveOld(chain))
 expect(tree!.root.findAllByType(OptionChainRow)[0].props.contract.strike).toBe(200)
 act(() => tree!.unmount())
})
it('clears a selected spread strike when expiry changes', async () => {
 api.mockResolvedValue(chain)
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 await act(async () => tree!.root.findAllByType(Chip).find(c => c.props.label === 'Long call spread')!.props.onPress())
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 const expiryTab = tree!.root.findAllByType(Chip)[7]
 await act(async () => expiryTab.props.onPress())
 expect(api).toHaveBeenLastCalledWith('TEST',1800600000,{fresh:false})
 expect(tree!.root.findAllByType(OptionChainRow).every(row => !row.props.selected)).toBe(true)
 act(() => tree!.unmount())
})
it('does not fabricate missing Greeks or adjusted-contract dollar totals', () => {
 let tree: ReturnType<typeof create>
 act(() => { tree = create(<OptionChainRow contract={{...contract(100),delta:undefined,gamma:undefined,multiplier:undefined}} />) })
 const text = JSON.stringify(tree!.toJSON())
 expect(text).toContain('—')
 expect(text).not.toContain('300.00')
 expect(text).not.toContain('0.0000')
 act(() => tree!.unmount())
})
it('opens a single call detail and recalculates loss for an edited premium', async () => {
 api.mockResolvedValue(chain)
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 expect(JSON.stringify(tree!.toJSON())).toContain('Unlimited')
 const input = tree!.root.findByType(require('react-native').TextInput)
 await act(async () => input.props.onChangeText('4'))
 expect(JSON.stringify(tree!.toJSON())).toContain('$400.00')
 act(() => tree!.unmount())
})
it('explicit refresh bypasses cache and clears selection', async () => {
 api.mockResolvedValue(chain)
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 const refresh = tree!.root.findByProps({accessibilityLabel:'Refresh quotes'})
 await act(async () => refresh.props.onPress())
 expect(api).toHaveBeenLastCalledWith('TEST',1800000000,{fresh:true})
 expect(tree!.root.findAllByType(OptionChainRow).every(row => !row.props.selected)).toBe(true)
 act(() => tree!.unmount())
})
it('compares the net premium and signed Greeks of each spread candidate before opening detail', async () => {
 api.mockResolvedValue({...chain,calls:[
  {...contract(100),bid:5,ask:6,delta:.7,gamma:.04},
  {...contract(110),bid:2,ask:3,delta:.4,gamma:.02},
  {...contract(120),bid:1,ask:2,delta:.2,gamma:.01},
 ]})
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 await act(async () => tree!.root.findAllByType(Chip).find(c => c.props.label === 'Long call spread')!.props.onPress())
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 const cells = (index: number) => tree!.root.findAllByType(OptionChainRow)[index].findAllByType(require('../OptionChainRow').Cell).map(cell => cell.props.value)
 expect(cells(1)).toEqual(['4.00','400.00','2.00','4.00','0.3000','0.0200'])
 expect(cells(2)).toEqual(['5.00','500.00','3.00','5.00','0.5000','0.0300'])
 const text = JSON.stringify(tree!.toJSON())
 expect(text).toContain('Buy')
 expect(text).toContain('Sell')
 expect(text).not.toContain('Maximum profit')
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 expect(tree!.root.findAllByType(OptionChainRow).every(row => !row.props.selected)).toBe(true)
 await act(async () => tree!.root.findAllByType(Chip).find(c => c.props.label === 'Short call spread')!.props.onPress())
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 expect(cells(1)).toEqual(['-2.00','-200.00','-4.00','-2.00','-0.3000','-0.0200'])
 expect(JSON.stringify(tree!.toJSON())).toContain('Receive')
 act(() => tree!.unmount())
})
it('distinguishes the same expiry month and day in different years', async () => {
 const first = Date.UTC(2026,9,16)/1000
 const second = Date.UTC(2027,9,16)/1000
 api.mockResolvedValue({...chain,expiration:first,expirationDates:[first,second]})
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 const labels = tree!.root.findAllByType(Chip).map(chip => chip.props.label)
 expect(labels).toContain('2026-10-16')
 expect(labels).toContain('2027-10-16')
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 expect(JSON.stringify(tree!.toJSON())).toContain('2026-10-16')
 act(() => tree!.unmount())
})
it('formats a floating-point spread entry estimate to cents', async () => {
 api.mockResolvedValue({...chain,calls:[
  {...contract(100),bid:12,ask:12.2},
  {...contract(110),bid:6.8,ask:7},
 ]})
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 await act(async () => tree!.root.findAllByType(Chip).find(c => c.props.label === 'Long call spread')!.props.onPress())
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 await act(async () => tree!.root.findAllByType(OptionChainRow)[1].props.onPress())
 expect(tree!.root.findByType(require('react-native').TextInput).props.placeholder).toBe('5.40')
 act(() => tree!.unmount())
})
it('explains unavailable totals when the contract deliverable is unverified', async () => {
 api.mockResolvedValue({...chain,calls:[{...contract(100),multiplier:null}]})
 let tree: ReturnType<typeof create>
 await act(async () => { tree = create(<OptionsSection symbol="TEST" active />) })
 await act(async () => tree!.root.findAllByType(OptionChainRow)[0].props.onPress())
 expect(JSON.stringify(tree!.toJSON())).toContain('Contract size is unverified or is not the standard 100 shares, so totals and expiration payoff are unavailable.')
 act(() => tree!.unmount())
})
