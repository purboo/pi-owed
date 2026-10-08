---- MODULE PiDagStrength_TTrace_1791459840 ----
EXTENDS Sequences, TLCExt, Toolbox, PiDagStrength, Naturals, TLC

_expression ==
    LET PiDagStrength_TEExpression == INSTANCE PiDagStrength_TEExpression
    IN PiDagStrength_TEExpression!expression
----

_trace ==
    LET PiDagStrength_TETrace == INSTANCE PiDagStrength_TETrace
    IN PiDagStrength_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        impl = ("good")
        /\
        admitted = (1)
        /\
        test = ("strong")
        /\
        testV = (1)
        /\
        cfPick = ({})
        /\
        execObs = ({"pass"})
        /\
        merged = (TRUE)
        /\
        cfBase = ({"expected"})
        /\
        fake = (FALSE)
        /\
        implV = (1)
        /\
        testAuthor = ("writer")
    )
----

_init ==
    /\ testAuthor = _TETrace[1].testAuthor
    /\ testV = _TETrace[1].testV
    /\ merged = _TETrace[1].merged
    /\ fake = _TETrace[1].fake
    /\ cfBase = _TETrace[1].cfBase
    /\ test = _TETrace[1].test
    /\ impl = _TETrace[1].impl
    /\ implV = _TETrace[1].implV
    /\ cfPick = _TETrace[1].cfPick
    /\ execObs = _TETrace[1].execObs
    /\ admitted = _TETrace[1].admitted
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ testAuthor  = _TETrace[i].testAuthor
        /\ testAuthor' = _TETrace[j].testAuthor
        /\ testV  = _TETrace[i].testV
        /\ testV' = _TETrace[j].testV
        /\ merged  = _TETrace[i].merged
        /\ merged' = _TETrace[j].merged
        /\ fake  = _TETrace[i].fake
        /\ fake' = _TETrace[j].fake
        /\ cfBase  = _TETrace[i].cfBase
        /\ cfBase' = _TETrace[j].cfBase
        /\ test  = _TETrace[i].test
        /\ test' = _TETrace[j].test
        /\ impl  = _TETrace[i].impl
        /\ impl' = _TETrace[j].impl
        /\ implV  = _TETrace[i].implV
        /\ implV' = _TETrace[j].implV
        /\ cfPick  = _TETrace[i].cfPick
        /\ cfPick' = _TETrace[j].cfPick
        /\ execObs  = _TETrace[i].execObs
        /\ execObs' = _TETrace[j].execObs
        /\ admitted  = _TETrace[i].admitted
        /\ admitted' = _TETrace[j].admitted

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("PiDagStrength_TTrace_1791459840.json", _TETrace)

=============================================================================

 Note that you can extract this module `PiDagStrength_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `PiDagStrength_TEExpression.tla` file takes precedence 
  over the module `PiDagStrength_TEExpression` below).

---- MODULE PiDagStrength_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, PiDagStrength, Naturals, TLC

expression == 
    [
        \* To hide variables of the `PiDagStrength` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        testAuthor |-> testAuthor
        ,testV |-> testV
        ,merged |-> merged
        ,fake |-> fake
        ,cfBase |-> cfBase
        ,test |-> test
        ,impl |-> impl
        ,implV |-> implV
        ,cfPick |-> cfPick
        ,execObs |-> execObs
        ,admitted |-> admitted
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_testAuthorUnchanged |-> testAuthor = testAuthor'
        
        \* Format the `testAuthor` variable as Json value.
        \* ,_testAuthorJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(testAuthor)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_testAuthorModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].testAuthor # _TETrace[s-1].testAuthor
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE PiDagStrength_TETrace ----
\*EXTENDS IOUtils, PiDagStrength, TLC
\*
\*trace == IODeserialize("PiDagStrength_TTrace_1791459840.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE PiDagStrength_TETrace ----
EXTENDS PiDagStrength, TLC

trace == 
    <<
    ([impl |-> "none",admitted |-> -1,test |-> "none",testV |-> 0,cfPick |-> {},execObs |-> {},merged |-> FALSE,cfBase |-> {},fake |-> FALSE,implV |-> 0,testAuthor |-> "none"]),
    ([impl |-> "none",admitted |-> -1,test |-> "strong",testV |-> 1,cfPick |-> {},execObs |-> {},merged |-> FALSE,cfBase |-> {},fake |-> FALSE,implV |-> 0,testAuthor |-> "writer"]),
    ([impl |-> "good",admitted |-> -1,test |-> "strong",testV |-> 1,cfPick |-> {},execObs |-> {},merged |-> FALSE,cfBase |-> {},fake |-> FALSE,implV |-> 1,testAuthor |-> "writer"]),
    ([impl |-> "good",admitted |-> 1,test |-> "strong",testV |-> 1,cfPick |-> {},execObs |-> {},merged |-> FALSE,cfBase |-> {},fake |-> FALSE,implV |-> 1,testAuthor |-> "writer"]),
    ([impl |-> "good",admitted |-> 1,test |-> "strong",testV |-> 1,cfPick |-> {},execObs |-> {"pass"},merged |-> FALSE,cfBase |-> {},fake |-> FALSE,implV |-> 1,testAuthor |-> "writer"]),
    ([impl |-> "good",admitted |-> 1,test |-> "strong",testV |-> 1,cfPick |-> {},execObs |-> {"pass"},merged |-> FALSE,cfBase |-> {"expected"},fake |-> FALSE,implV |-> 1,testAuthor |-> "writer"]),
    ([impl |-> "good",admitted |-> 1,test |-> "strong",testV |-> 1,cfPick |-> {},execObs |-> {"pass"},merged |-> TRUE,cfBase |-> {"expected"},fake |-> FALSE,implV |-> 1,testAuthor |-> "writer"])
    >>
----


=============================================================================

---- CONFIG PiDagStrength_TTrace_1791459840 ----
CONSTANTS
    Mode = "a21"
    MaxVer = 3

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
\* Generated on Thu Oct 08 19:44:00 CST 2026