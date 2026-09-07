import { finish } from "./common";
import { testHistory } from "./history.test";
import { testOps } from "./ops.test";
import { testMove } from "./move.test";
import { testSym } from "./sym.test";

console.log("--- history ---");
testHistory();
console.log("--- ops ---");
testOps();
console.log("--- move ---");
testMove();
console.log("--- sym ---");
testSym();
finish();