---- MODULE PiDagAuth_TTrace_1791459892 ----
EXTENDS Sequences, TLCExt, Toolbox, Naturals, TLC, PiDagAuth

_expression ==
    LET PiDagAuth_TEExpression == INSTANCE PiDagAuth_TEExpression
    IN PiDagAuth_TEExpression!expression
----

_trace ==
    LET PiDagAuth_TETrace == INSTANCE PiDagAuth_TETrace
    IN PiDagAuth_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        ver = ([n1 |-> 0, n2 |-> 0])
        /\
        log = (<<[v |-> 0, type |-> "grant", from |-> "owner", to |-> "parent", scope |-> "-", node |-> "-"], [v |-> 0, type |-> "grant", from |-> "parent", to |-> "w1", scope |-> "-", node |-> "-"], [v |-> 0, type |-> "revoke", from |-> "owner", to |-> "parent", scope |-> "future", node |-> "-"], [v |-> 0, type |-> "waive", from |-> "w1", to |-> "-", scope |-> "-", node |-> "n2"]>>)
    )
----

_init ==
    /\ ver = _TETrace[1].ver
    /\ log = _TETrace[1].log
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ ver  = _TETrace[i].ver
        /\ ver' = _TETrace[j].ver
        /\ log  = _TETrace[i].log
        /\ log' = _TETrace[j].log

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("PiDagAuth_TTrace_1791459892.json", _TETrace)

=============================================================================

 Note that you can extract this module `PiDagAuth_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `PiDagAuth_TEExpression.tla` file takes precedence 
  over the module `PiDagAuth_TEExpression` below).

---- MODULE PiDagAuth_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, Naturals, TLC, PiDagAuth

expression == 
    [
        \* To hide variables of the `PiDagAuth` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        ver |-> ver
        ,log |-> log
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_verUnchanged |-> ver = ver'
        
        \* Format the `ver` variable as Json value.
        \* ,_verJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(ver)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_verModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].ver # _TETrace[s-1].ver
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE PiDagAuth_TETrace ----
\*EXTENDS IOUtils, TLC, PiDagAuth
\*
\*trace == IODeserialize("PiDagAuth_TTrace_1791459892.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE PiDagAuth_TETrace ----
EXTENDS TLC, PiDagAuth

trace == 
    <<
    ([ver |-> [n1 |-> 0, n2 |-> 0],log |-> <<>>]),
    ([ver |-> [n1 |-> 0, n2 |-> 0],log |-> <<[v |-> 0, type |-> "grant", from |-> "owner", to |-> "parent", scope |-> "-", node |-> "-"]>>]),
    ([ver |-> [n1 |-> 0, n2 |-> 0],log |-> <<[v |-> 0, type |-> "grant", from |-> "owner", to |-> "parent", scope |-> "-", node |-> "-"], [v |-> 0, type |-> "grant", from |-> "parent", to |-> "w1", scope |-> "-", node |-> "-"]>>]),
    ([ver |-> [n1 |-> 0, n2 |-> 0],log |-> <<[v |-> 0, type |-> "grant", from |-> "owner", to |-> "parent", scope |-> "-", node |-> "-"], [v |-> 0, type |-> "grant", from |-> "parent", to |-> "w1", scope |-> "-", node |-> "-"], [v |-> 0, type |-> "revoke", from |-> "owner", to |-> "parent", scope |-> "future", node |-> "-"]>>]),
    ([ver |-> [n1 |-> 0, n2 |-> 0],log |-> <<[v |-> 0, type |-> "grant", from |-> "owner", to |-> "parent", scope |-> "-", node |-> "-"], [v |-> 0, type |-> "grant", from |-> "parent", to |-> "w1", scope |-> "-", node |-> "-"], [v |-> 0, type |-> "revoke", from |-> "owner", to |-> "parent", scope |-> "future", node |-> "-"], [v |-> 0, type |-> "waive", from |-> "w1", to |-> "-", scope |-> "-", node |-> "n2"]>>])
    >>
----


=============================================================================

---- CONFIG PiDagAuth_TTrace_1791459892 ----
CONSTANTS
    Mode = "lit"
    MaxLog = 4
    MaxVer = 1

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
\* Generated on Thu Oct 08 19:44:53 CST 2026