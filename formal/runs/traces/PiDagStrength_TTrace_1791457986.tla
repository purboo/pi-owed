---- MODULE PiDagStrength_TTrace_1791457986 ----
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
        impl = ("bad")
        /\
        admitted = (-1)
        /\
        obs = ({[cf |-> "none", kind |-> "exec", who |-> "writer", r |-> "pass", iv |-> 1, tv |-> 1], [cf |-> "pick", kind |-> "cf", who |-> "writer", r |-> "expected", iv |-> 1, tv |-> 1]})
        /\
        test = ("strong")
        /\
        testV = (1)
        /\
        merged = (TRUE)
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
    /\ test = _TETrace[1].test
    /\ impl = _TETrace[1].impl
    /\ implV = _TETrace[1].implV
    /\ admitted = _TETrace[1].admitted
    /\ obs = _TETrace[1].obs
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
        /\ test  = _TETrace[i].test
        /\ test' = _TETrace[j].test
        /\ impl  = _TETrace[i].impl
        /\ impl' = _TETrace[j].impl
        /\ implV  = _TETrace[i].implV
        /\ implV' = _TETrace[j].implV
        /\ admitted  = _TETrace[i].admitted
        /\ admitted' = _TETrace[j].admitted
        /\ obs  = _TETrace[i].obs
        /\ obs' = _TETrace[j].obs

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("PiDagStrength_TTrace_1791457986.json", _TETrace)

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
        ,test |-> test
        ,impl |-> impl
        ,implV |-> implV
        ,admitted |-> admitted
        ,obs |-> obs
        
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
\*trace == IODeserialize("PiDagStrength_TTrace_1791457986.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE PiDagStrength_TETrace ----
EXTENDS PiDagStrength, TLC

trace == 
    <<
    ([impl |-> "none",admitted |-> -1,obs |-> {},test |-> "none",testV |-> 0,merged |-> FALSE,implV |-> 0,testAuthor |-> "none"]),
    ([impl |-> "none",admitted |-> -1,obs |-> {},test |-> "strong",testV |-> 1,merged |-> FALSE,implV |-> 0,testAuthor |-> "writer"]),
    ([impl |-> "bad",admitted |-> -1,obs |-> {},test |-> "strong",testV |-> 1,merged |-> FALSE,implV |-> 1,testAuthor |-> "writer"]),
    ([impl |-> "bad",admitted |-> -1,obs |-> {[cf |-> "pick", kind |-> "cf", who |-> "writer", r |-> "expected", iv |-> 1, tv |-> 1]},test |-> "strong",testV |-> 1,merged |-> FALSE,implV |-> 1,testAuthor |-> "writer"]),
    ([impl |-> "bad",admitted |-> -1,obs |-> {[cf |-> "none", kind |-> "exec", who |-> "writer", r |-> "pass", iv |-> 1, tv |-> 1], [cf |-> "pick", kind |-> "cf", who |-> "writer", r |-> "expected", iv |-> 1, tv |-> 1]},test |-> "strong",testV |-> 1,merged |-> FALSE,implV |-> 1,testAuthor |-> "writer"]),
    ([impl |-> "bad",admitted |-> -1,obs |-> {[cf |-> "none", kind |-> "exec", who |-> "writer", r |-> "pass", iv |-> 1, tv |-> 1], [cf |-> "pick", kind |-> "cf", who |-> "writer", r |-> "expected", iv |-> 1, tv |-> 1]},test |-> "strong",testV |-> 1,merged |-> TRUE,implV |-> 1,testAuthor |-> "writer"])
    >>
----


=============================================================================

---- CONFIG PiDagStrength_TTrace_1791457986 ----
CONSTANTS
    Mode = "a1"
    MaxVer = 2

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
\* Generated on Thu Oct 08 19:13:08 CST 2026