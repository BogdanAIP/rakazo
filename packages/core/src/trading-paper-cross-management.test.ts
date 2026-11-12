import {describe,expect,it} from "vitest";
import {planPaperHalfExit} from "./trading-paper-cross-management.js";
const base={
 side:"long" as const,entryPriceQuote:"100",originalStopPriceQuote:"95",
 markPriceQuote:"108",quantityBase:"2",lotIncrementBase:"0.01",minimumBase:"0.01",
 priceIncrement:"0.01",feeBpsPerSide:5,slippageBpsPerSide:10,fundingReserveBps:5,
};
describe("PAPER confirmed half-profit and protected remainder",()=>{
 it("plans half close only above 1.5R",()=>{
  const x=planPaperHalfExit(base);
  expect(x.status).toBe("ready");
  if(x.status!=="ready")return;
  expect(x.quantityBase).toBe("1");
  expect(Number(x.breakEvenStop)).toBeGreaterThan(100);
  expect(Number(x.breakEvenStop)).toBeLessThan(108);
  expect(x.triggerPrice).toBe("107.5");
  expect(planPaperHalfExit({...base,markPriceQuote:"107"})).toEqual({status:"not_ready",reason:"below_1_5R"});
 });
 it("applies short BE below entry and above current market",()=>{
  const x=planPaperHalfExit({...base,side:"short",originalStopPriceQuote:"105",markPriceQuote:"92"});
  expect(x.status).toBe("ready");
  if(x.status==="ready"){
   expect(x.quantityBase).toBe("1");
   expect(Number(x.breakEvenStop)).toBeLessThan(100);
   expect(Number(x.breakEvenStop)).toBeGreaterThan(92);
  }
 });
 it("refuses dust and excessive cost assumptions",()=>{
  expect(planPaperHalfExit({...base,quantityBase:"0.01"}).status).toBe("not_ready");
  expect(planPaperHalfExit({...base,feeBpsPerSide:250}).status).toBe("not_ready");
 });
});