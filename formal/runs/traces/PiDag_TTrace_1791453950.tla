---- MODULE PiDag_TTrace_1791453950 ----
EXTENDS Sequences, TLCExt, Toolbox, PiDag, Naturals, TLC, PiDag_TEConstants

_expression ==
    LET PiDag_TEExpression == INSTANCE PiDag_TEExpression
    IN PiDag_TEExpression!expression
----

_trace ==
    LET PiDag_TETrace == INSTANCE PiDag_TETrace
    IN PiDag_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        downgraded = ((n1 :> TRUE @@ n2 :> FALSE))
        /\
        reviewReq = ((n1 :> FALSE @@ n2 :> TRUE))
        /\
        author = ((n1 :> "holder" @@ n2 :> "none"))
        /\
        pending = ((n1 :> -1 @@ n2 :> -1))
        /\
        reviewObs = ((n1 :> "block" @@ n2 :> "none"))
        /\
        epoch = ((n1 :> 1 @@ n2 :> 0))
        /\
        writers = ((n1 :> {1} @@ n2 :> {}))
        /\
        trunk = ({n1})
        /\
        version = (1)
        /\
        quality = ((n1 :> "bad" @@ n2 :> "none"))
        /\
        waived = ((n1 :> "none" @@ n2 :> "none"))
        /\
        debtMerges = (0)
        /\
        gDebt = (FALSE)
        /\
        violation = ({})
        /\
        testObs = ((n1 :> {"pass"} @@ n2 :> {}))
        /\
        trunkSeq = (1)
    )
----

_init ==
    /\ debtMerges = _TETrace[1].debtMerges
    /\ pending = _TETrace[1].pending
    /\ reviewObs = _TETrace[1].reviewObs
    /\ downgraded = _TETrace[1].downgraded
    /\ quality = _TETrace[1].quality
    /\ epoch = _TETrace[1].epoch
    /\ gDebt = _TETrace[1].gDebt
    /\ trunkSeq = _TETrace[1].trunkSeq
    /\ writers = _TETrace[1].writers
    /\ waived = _TETrace[1].waived
    /\ testObs = _TETrace[1].testObs
    /\ reviewReq = _TETrace[1].reviewReq
    /\ version = _TETrace[1].version
    /\ author = _TETrace[1].author
    /\ violation = _TETrace[1].violation
    /\ trunk = _TETrace[1].trunk
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ debtMerges  = _TETrace[i].debtMerges
        /\ debtMerges' = _TETrace[j].debtMerges
        /\ pending  = _TETrace[i].pending
        /\ pending' = _TETrace[j].pending
        /\ reviewObs  = _TETrace[i].reviewObs
        /\ reviewObs' = _TETrace[j].reviewObs
        /\ downgraded  = _TETrace[i].downgraded
        /\ downgraded' = _TETrace[j].downgraded
        /\ quality  = _TETrace[i].quality
        /\ quality' = _TETrace[j].quality
        /\ epoch  = _TETrace[i].epoch
        /\ epoch' = _TETrace[j].epoch
        /\ gDebt  = _TETrace[i].gDebt
        /\ gDebt' = _TETrace[j].gDebt
        /\ trunkSeq  = _TETrace[i].trunkSeq
        /\ trunkSeq' = _TETrace[j].trunkSeq
        /\ writers  = _TETrace[i].writers
        /\ writers' = _TETrace[j].writers
        /\ waived  = _TETrace[i].waived
        /\ waived' = _TETrace[j].waived
        /\ testObs  = _TETrace[i].testObs
        /\ testObs' = _TETrace[j].testObs
        /\ reviewReq  = _TETrace[i].reviewReq
        /\ reviewReq' = _TETrace[j].reviewReq
        /\ version  = _TETrace[i].version
        /\ version' = _TETrace[j].version
        /\ author  = _TETrace[i].author
        /\ author' = _TETrace[j].author
        /\ violation  = _TETrace[i].violation
        /\ violation' = _TETrace[j].violation
        /\ trunk  = _TETrace[i].trunk
        /\ trunk' = _TETrace[j].trunk

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("PiDag_TTrace_1791453950.json", _TETrace)

=============================================================================

 Note that you can extract this module `PiDag_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `PiDag_TEExpression.tla` file takes precedence 
  over the module `PiDag_TEExpression` below).

---- MODULE PiDag_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, PiDag, Naturals, TLC, PiDag_TEConstants

expression == 
    [
        \* To hide variables of the `PiDag` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        debtMerges |-> debtMerges
        ,pending |-> pending
        ,reviewObs |-> reviewObs
        ,downgraded |-> downgraded
        ,quality |-> quality
        ,epoch |-> epoch
        ,gDebt |-> gDebt
        ,trunkSeq |-> trunkSeq
        ,writers |-> writers
        ,waived |-> waived
        ,testObs |-> testObs
        ,reviewReq |-> reviewReq
        ,version |-> version
        ,author |-> author
        ,violation |-> violation
        ,trunk |-> trunk
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_debtMergesUnchanged |-> debtMerges = debtMerges'
        
        \* Format the `debtMerges` variable as Json value.
        \* ,_debtMergesJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(debtMerges)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_debtMergesModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].debtMerges # _TETrace[s-1].debtMerges
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE PiDag_TETrace ----
\*EXTENDS IOUtils, PiDag, TLC, PiDag_TEConstants
\*
\*trace == IODeserialize("PiDag_TTrace_1791453950.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE PiDag_TETrace ----
EXTENDS PiDag, TLC, PiDag_TEConstants

trace == 
    <<
    ([downgraded |-> (n1 :> FALSE @@ n2 :> FALSE),reviewReq |-> (n1 :> TRUE @@ n2 :> TRUE),author |-> (n1 :> "none" @@ n2 :> "none"),pending |-> (n1 :> -1 @@ n2 :> -1),reviewObs |-> (n1 :> "none" @@ n2 :> "none"),epoch |-> (n1 :> 0 @@ n2 :> 0),writers |-> (n1 :> {} @@ n2 :> {}),trunk |-> {},version |-> 0,quality |-> (n1 :> "none" @@ n2 :> "none"),waived |-> (n1 :> "none" @@ n2 :> "none"),debtMerges |-> 0,gDebt |-> FALSE,violation |-> {},testObs |-> (n1 :> {} @@ n2 :> {}),trunkSeq |-> 0]),
    ([downgraded |-> (n1 :> FALSE @@ n2 :> FALSE),reviewReq |-> (n1 :> TRUE @@ n2 :> TRUE),author |-> (n1 :> "none" @@ n2 :> "none"),pending |-> (n1 :> -1 @@ n2 :> -1),reviewObs |-> (n1 :> "none" @@ n2 :> "none"),epoch |-> (n1 :> 1 @@ n2 :> 0),writers |-> (n1 :> {1} @@ n2 :> {}),trunk |-> {},version |-> 0,quality |-> (n1 :> "none" @@ n2 :> "none"),waived |-> (n1 :> "none" @@ n2 :> "none"),debtMerges |-> 0,gDebt |-> FALSE,violation |-> {},testObs |-> (n1 :> {} @@ n2 :> {}),trunkSeq |-> 0]),
    ([downgraded |-> (n1 :> TRUE @@ n2 :> FALSE),reviewReq |-> (n1 :> FALSE @@ n2 :> TRUE),author |-> (n1 :> "none" @@ n2 :> "none"),pending |-> (n1 :> -1 @@ n2 :> -1),reviewObs |-> (n1 :> "none" @@ n2 :> "none"),epoch |-> (n1 :> 1 @@ n2 :> 0),writers |-> (n1 :> {1} @@ n2 :> {}),trunk |-> {},version |-> 1,quality |-> (n1 :> "none" @@ n2 :> "none"),waived |-> (n1 :> "none" @@ n2 :> "none"),debtMerges |-> 0,gDebt |-> FALSE,violation |-> {},testObs |-> (n1 :> {} @@ n2 :> {}),trunkSeq |-> 0]),
    ([downgraded |-> (n1 :> TRUE @@ n2 :> FALSE),reviewReq |-> (n1 :> FALSE @@ n2 :> TRUE),author |-> (n1 :> "holder" @@ n2 :> "none"),pending |-> (n1 :> -1 @@ n2 :> -1),reviewObs |-> (n1 :> "none" @@ n2 :> "none"),epoch |-> (n1 :> 1 @@ n2 :> 0),writers |-> (n1 :> {1} @@ n2 :> {}),trunk |-> {},version |-> 1,quality |-> (n1 :> "bad" @@ n2 :> "none"),waived |-> (n1 :> "none" @@ n2 :> "none"),debtMerges |-> 0,gDebt |-> FALSE,violation |-> {},testObs |-> (n1 :> {} @@ n2 :> {}),trunkSeq |-> 0]),
    ([downgraded |-> (n1 :> TRUE @@ n2 :> FALSE),reviewReq |-> (n1 :> FALSE @@ n2 :> TRUE),author |-> (n1 :> "holder" @@ n2 :> "none"),pending |-> (n1 :> -1 @@ n2 :> -1),reviewObs |-> (n1 :> "none" @@ n2 :> "none"),epoch |-> (n1 :> 1 @@ n2 :> 0),writers |-> (n1 :> {1} @@ n2 :> {}),trunk |-> {},version |-> 1,quality |-> (n1 :> "bad" @@ n2 :> "none"),waived |-> (n1 :> "none" @@ n2 :> "none"),debtMerges |-> 0,gDebt |-> FALSE,violation |-> {},testObs |-> (n1 :> {"pass"} @@ n2 :> {}),trunkSeq |-> 0]),
    ([downgraded |-> (n1 :> TRUE @@ n2 :> FALSE),reviewReq |-> (n1 :> FALSE @@ n2 :> TRUE),author |-> (n1 :> "holder" @@ n2 :> "none"),pending |-> (n1 :> -1 @@ n2 :> -1),reviewObs |-> (n1 :> "block" @@ n2 :> "none"),epoch |-> (n1 :> 1 @@ n2 :> 0),writers |-> (n1 :> {1} @@ n2 :> {}),trunk |-> {},version |-> 1,quality |-> (n1 :> "bad" @@ n2 :> "none"),waived |-> (n1 :> "none" @@ n2 :> "none"),debtMerges |-> 0,gDebt |-> FALSE,violation |-> {},testObs |-> (n1 :> {"pass"} @@ n2 :> {}),trunkSeq |-> 0]),
    ([downgraded |-> (n1 :> TRUE @@ n2 :> FALSE),reviewReq |-> (n1 :> FALSE @@ n2 :> TRUE),author |-> (n1 :> "holder" @@ n2 :> "none"),pending |-> (n1 :> -1 @@ n2 :> -1),reviewObs |-> (n1 :> "block" @@ n2 :> "none"),epoch |-> (n1 :> 1 @@ n2 :> 0),writers |-> (n1 :> {1} @@ n2 :> {}),trunk |-> {n1},version |-> 1,quality |-> (n1 :> "bad" @@ n2 :> "none"),waived |-> (n1 :> "none" @@ n2 :> "none"),debtMerges |-> 0,gDebt |-> FALSE,violation |-> {},testObs |-> (n1 :> {"pass"} @@ n2 :> {}),trunkSeq |-> 1])
    >>
----


=============================================================================

---- MODULE PiDag_TEConstants ----
EXTENDS PiDag

CONSTANTS n1, n2

=============================================================================

---- CONFIG PiDag_TTrace_1791453950 ----
CONSTANTS
    Nodes = { n1 , n2 }
    Mode = "a2"
    MaxEpoch = 2
    MaxVersion = 2
    n1 = n1
    n2 = n2

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Thu Oct 08 18:05:51 CST 2026