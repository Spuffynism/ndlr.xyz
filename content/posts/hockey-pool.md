---
title: A 99th percentile hockey pool builder
description: Using constraint solving techniques to build a fantasy hockey team
date: 2023-09-23
draft: false
---

###### Have a moment to talk about our lord and savior [Moneyball (2011)](https://boxd.it/1AU56H)?

A few months ago, [I was playing with Prolog](https://gist.github.com/Spuffynism/446c7c2d498477491d8137e8f234d4a9) which got me thinking about possible applications for constraint solvers. Prolog offers a straightforward syntax to express constraints. This led me to explore constraint solving techniques in the context of maximizing points from players for a hockey pool.

With a score of 2502, the strategy detailed here would rank us in position #74 out of 16,733 of [La Presse's 2022-2023 hockey pool](https://poolhockey.lapresse.ca/index.php) (no affiliation!), ranking around the 99.56th percentile. Not too bad!

Using a variant of the knapsack problem, we build a team that respects our salary cap, while maximizing the value that players bring. We use players' salary, their scored points, and game logs across seasons to backtest our strategy.

Let's go through the steps necessary to build said team.

## The rules

First, we must define the problem's constraints.

La Presse's hockey pool (which we will be using) uses these constraints:
* The salary cap is $82.5m
* The team must be composed of 2 goalies, 6 defenders and 12 forwards

The sum of the players' cap hit can never be above the salary cap. That the team must always respect the player type composition.

Points are scored  as follows:
* Goalies get 3 points per win, 5 points per shutout, 5 points per goal and 2 points per pass
* Defenders get 3 points per goal and 2 points per pass
* Forwards get 2 points per goal and 1 point per pass

The pool allows for up to 5 exchanges per month, for every month of the season. The regular NHL 2022-2023 season started on [October 7th 2022 and ended on April 13th 2023](https://www.nhl.com/news/nhl-releases-2022-23-regular-season-schedule/c-334820504). This means we get 5 potential exchanges for each of the 7 months of the season.

Now that we've determined exactly what data we need, let's gather it.

## Sourcing the data

I wasn't able to find a single source of data that contained player's statistics and cap hits throughout seasons, so I joined multiple data sources together.

### Data gathering

For player stats, Hockey Reference offers downloadable CSV files. Basic, advanced and miscellaneous statistics for players are downloadable in different files. We download each file, and parse them to dataframes. Then, we join the dataframes together using pandas' merge function. This then becomes a single dataframe with rows representing players and columns representing their statistics.

We load the CSV with this function:

```python
def _load_to_df(self, player_type, stats_type, columns, dtype=None):
     return (
         pd.read_csv(
             f"data/hockey_reference/{self.season}_{player_type}_{stats_type}.csv",
             header=1,
             usecols=list(columns.keys()) + [ID_COLUMN],
         )
         .rename(columns=columns)
         .astype(dtype if dtype is not None else {})
         # Per-player totals are in the first row. Following rows for same player are
         # stats per-player, per-team.
         .drop_duplicates(subset=ID_COLUMN, keep="first")
     )
```

And join the dataframes together with this code, into a dataframe `df`:

```python
basic = self._load_to_df(
   "skaters",
   "basic",
   columns={
       "Pos": "position",
       "G": "goals",
       "A": "assists",
       "GP": "games_played",
       "Player": "name",
   },
)
basic = basic[basic["position"].isin(player_positions[player_type])]

advanced = self._load_to_df("skaters", "advanced", columns={"Pos": "position"})
advanced = advanced[advanced["position"].isin(player_positions[player_type])]

df = pd.merge(basic, advanced, how="left", on=ID_COLUMN, suffixes=("", "_y"))
df = df.drop(df.filter(regex="_y$").columns, axis=1)
df = df.merge(misc, how="left", on=ID_COLUMN, suffixes=("", "_y"))
df = df.drop(df.filter(regex="_y$").columns, axis=1)
```

For statistics across games, we also use Hockey Reference as a data source.

Regular games for each season are listed in a nicely structured html table on `https://www.hockey-reference.com/leagues/NHL_{season}_games.html` ([the 2022 season, for example](https://www.hockey-reference.com/leagues/NHL_2022_games.html)). For every row in the table, we visit the corresponding game's page, which contains a bunch of tables with very detailed statistics for the game. For our purpose, the only data points we want are the scoring summary table, and the goalie statistics table. In these two tables, we have data that allows us to track player statistics across games. This is key data for backtesting player trades as the season progresses. For players, that's the points they score and their assists. For goalies, that's the decision (loss, win, or win in overtime), their total saves, their saves percentage, and if the game ended in a shutout.

For player salaries, I reverse-engineered cap-friendly's API to query for salaries by season:

```python
def build_url(self, player_type, page):
    return (
        f"https://www.capfriendly.com/ajax/browse/active/{self.season}/caphit/all/{player_type}"
        f"?stats-season={self.season}"
        "&hide=team,clauses,age,position,handed,expiry-status,salary"
        f"&pg={page}"
    )
```

A simple GET request to the URL with the right parameters provides us with a list of players with their respective salaries. This is saved as a CSV for easy loading in a dataframe at a later time as well.

### Data massaging

Once we've crawled everything, the data must be massaged into a state usable by the solver.

Players as listed by Hockey Reference and CapFriendly are not referred to by the same name. To fix this issue, I manually built an equivalence map between names from both sources for 44 mismatched players:

```python
corrections = {
    "Mitchell Marner": "Mitch Marner",
    "Evgeni Dadonov": "Evgenii Dadonov",
    "Maxime Comtois": "Max Comtois",
    "Zachary Sanford": "Zach Sanford",
    "Samuel Blais": "Sammy Blais",
    "Nicholas Paul": "Nick Paul",
    "Patrick Maroon": "Pat Maroon",
    "Joseph Veleno": "Joe Veleno",
    "Matthew Boldy": "Matt Boldy",
    "Nick Abruzzese": "Nicholas Abruzzese",
    # ... 34 more lines
```

Some goalies show up one season, but not another. Between the 2021-2022 and 2022-2023 seasons, we have three instances of this issue: Thomas Hodges, Matthew Berlin and Jett Alexander. All three are either emergency goaltenders, or one-time goaltenders which were brought during one of the two seasons. We just filter them out from our list of players to use in the solver.

Finally, some players are considered as defenders by one source, and forwards by another. Mason Geertsen, Hunter Drew, Luke Witkowski show up with this issue. As with the one-time goalies, they're filtered out.

After this little bit of housekeeping, we have a clean enough source of player stats across games and seasons! 🎉 Let's build the solver!

## Building the constraint solver

To encode the constraints as code, we use Google's [OR-tools](https://developers.google.com/optimization), a suite of tools to solve optimization problems. It's quite well documented and has a [bunch of examples on GitHub](https://github.com/google/or-tools/tree/stable/examples/python).

More precisely, we use the [CP-SAT solver](https://developers.google.com/optimization/cp/cp_solver#cp-sat_return_values), which is used to solve integer programming problems. We define the variables that represent our data, constrain them, and then solve for the best picks.

### Defining the constraints

First, let's declare the list of players as variables:

```python
x = {}
for j, players in enumerate(players_count):
    for i in range(players):
        x[i, j] = self.model.NewBoolVar(f'x_{i}_{j}')
```

`players_count` contains the number of players for each group (forwards, defenders, goalies). The inner loop creates a boolean variable (`NewBoolVar`) for each player, which represents if it's picked (when set to `1`) or isn't picked (when set to `0`). We store that variable in `x[i, j]` where `i` is the player index in its group `j`. `self.model` is an instance of the CP-SAT model we use for the solver.

Next, we set the desired size for each group:

```python
for j, (players, count) in enumerate(zip(players_count, PICKS_COUNT)):
    self.model.Add(
        cp_model.LinearExpr.Sum([x[i, j] for i in range(players)]) == count
    )
```

The count of players in each group must match the expected count: we want exactly 12 forwards, 6 defenders, and 2 goalies. We use a `cp_model.LinearExpr.Sum` instance because it's more efficient over large lists, but we could use the native `sum` python function as well since we have a small dataset.

Finally, we restrain the total salary cap of our picked players to the maximum salary cap:

```python
self.model.Add(
    cp_model.LinearExpr.Sum(
        [
            x[i, j] * pool[j][i]["weight"]
            for j in range(len(players_count))
            for i in range(players_count[j])
        ]
    )
    <= salary_cap
)
```

A player's (`x[i, j]`) weight (`pool[j][i]["weight"]`) is its cap hit for the season. This is similar to a constraint used in a knapsack multiple bins problem where we try to fit as many items with as much value as possible into as few bins as possible.

When selecting our initial pool, these are all the constraints we need. However, when trying to find potential exchanges as the season progresses, or when backtesting our strategy, we must constrain the potential exchanges:

```python
picks = []
for i, group in enumerate(solution.pick_indices):
    picks += [x[j, i] for j in group]

self.model.Add(
    cp_model.LinearExpr.Sum(picks)
    >= cp_model.LinearExpr.Sum(PICKS_COUNT) - trades_count
)
```

The count of players that we keep must be greater than or equal than the team size minus the amount of possible trades for the month. In other words, we can't trade more than 5 players per month.

### Maximizing the value

Now that the problem constraints are defined, we declare the solver's objective: maximizing the total value of our picks.

```python
expressions = []
coefficients = []
for j, players in enumerate(pool):
    for i in range(len(players)):
        expressions.append(x[i, j])
        coefficients.append(players[i]["value"])

self.model.Maximize(cp_model.LinearExpr.WeightedSum(expressions, coefficients))
```

Players are expressions, and their corresponding values are the coefficients. We maximize the sum of the selected players' value.

This brings us to an important question when selecting players: how do we quantify a player's value? Since the focus is on building a basic selection and trading algorithm, we use the same value strategy as La Presse. The value strategy options are pretty much infinite. One could delve into statistical analysis, machine learning, algorithmic trading strategies used on stocks or even portfolio rebalancing strategies to create a value strategy with an edge. I go over other simple value strategies we could use in the "Better value strategy" section.

For weighing players, we use their cap hit as it's what La Presse uses to weigh players as well, and because we have a salary cap we can't bust. This is a direct translation of the knapsack problem weight constraint.

As code, it looks like this:

```python
class LaPresseValueStrategy(ValueStrategy):
    def forward(self, player):
        return (player['goals'] * 2) + player['assists']
    
    def defender(self, player):
        return (player['goals'] * 3) + (player['assists'] * 2)
    
    def goalie(self, player):
        return (player['wins'] * 3) + (player['shutouts'] * 5) + (player['goals'] * 5) + (player['assists'] * 2)
```

Somewhat straightforward.

We have now collected the data required for backtesting, and built the solver to pick an initial alignment and trades as the season progresses. We're ready to backtest.

## Backtesting

To confirm our solver works, and that our player value strategy is sufficiently good, we need to backtest our strategy.

We will pick players according to the 2021-2022 season, and then backtest the trading solver as the season progresses on the 2022-2023 season. I've mentioned this earlier, but to improve the value strategy, we should look at more than a single season to determine our initial picks. A player's performance in a single season is not the best representation of their potential performance in the next season.

### Initial picks

The first step is to run the solver to pick an initial alignment. We feed player statistics for the regular 2021-2022 hockey season to the solver, with a few specific particularities:
1. We assign players the cap hits of the next season (2022-2023).
2. We limit the cap hit of the season to the one of the next season.

With the first adjustment, we prevent starting the season with a cap hit that's over the next season's salary cap. With the second adjustment, we maximize the total salary space that we have for picking players in the next season. As the salary cap went from $82.5m to $83.5m from the 2021-2022 season to the 2022-2023 season, we're getting an additional $1m to use for picking players.

In other words, we're picking players for the 2022-2023 season, while looking at their salary cap figures from the 2021-2022 season.

### Trading

With our player alignment chosen for the start of the season, we can simulate the season progress. Every month, we sum up the total amount of points that we gathered from our alignment. Then, we call the solver with our current alignment, and specify through a constraint that we're allowed up to 5 trades.

As each month progresses, we restrict player statistics fed to the solver to a window of the past month plus a week (in other words, we look at the past ~5 weeks). This duration is most definitely a local maximum of data across the two seasons I tested on, and I expect we'd find a more accurate one by testing across more seasons. Still, this window's duration seems to offer pertinent insights into a player's recent performance, which aligns with our objective of selecting players that will bring us points.

Restricting the window the solver looks at allows the solver to decide which trades to do based on a player's recent performance, which should be a better indicator of a player's future performance than its statistics since the start of the year. This also makes our modified knapsack algorithm pluck out players who get injured, get benched, or overall make less points, since their value for the window is lower.

When summing up points for past months, we use a different statistics window than the one we use to evaluate players through the solver. The statistics windows for counting points must not overlap with each other, to prevent double-counting points. Since we trade players at the end of each month, we count points based on the past month's statistics window.

The [progress function in the season simulator](https://github.com/Spuffynism/hockey-pool-picker/blob/3a30673142337ca849e47ffde4a157aab75779a8/season_simulator.py#L56-L136) is in charge of this trading logic.

## Results

With our solver having the trading logic implemented and backtested, we run it!

We start the year with this team alignment:

```
                  name position  games_played  goals  assists    normalized_name  cap_hit  value   weight  wins   saves  saves_percent  shutouts
0       Elias Lindholm        C            82     42       40      eliaslindholm  4850000    124  4850000   NaN     NaN            NaN       NaN
1   Jonathan Huberdeau       LW            80     30       85  jonathanhuberdeau  5900000    145  5900000   NaN     NaN            NaN       NaN
2         Jordan Kyrou        C            74     27       48        jordankyrou  2800000    102  2800000   NaN     NaN            NaN       NaN
3          J.T. Miller        C            80     32       67           jtmiller  5250000    131  5250000   NaN     NaN            NaN       NaN
4       Leon Draisaitl        C            80     55       55      leondraisaitl  8500000    165  8500000   NaN     NaN            NaN       NaN
5      Michael Bunting       LW            79     23       40     michaelbunting   950000     86   950000   NaN     NaN            NaN       NaN
6          Roope Hintz       LW            80     37       35         roopehintz  3150000    109  3150000   NaN     NaN            NaN       NaN
7         Ryan Hartman       RW            82     34       31        ryanhartman  1700000     99  1700000   NaN     NaN            NaN       NaN
8        Tage Thompson        C            78     38       30       tagethompson  1400000    106  1400000   NaN     NaN            NaN       NaN
9          Tim Stützle       LW            79     22       36         timstutzle   925000     80   925000   NaN     NaN            NaN       NaN
10       Trevor Zegras        C            75     23       38       trevorzegras   925000     84   925000   NaN     NaN            NaN       NaN
11          Troy Terry        C            75     37       30          troyterry  1450000    104  1450000   NaN     NaN            NaN       NaN
12          Cale Makar        D            77     28       58          calemakar  9000000    200  9000000   NaN     NaN            NaN       NaN
13       Evan Bouchard        D            81     12       31       evanbouchard   863333     98   863333   NaN     NaN            NaN       NaN
14         Kris Letang        D            78     10       58         krisletang  7250000    146  6100000   NaN     NaN            NaN       NaN
15       Moritz Seider        D            82      7       43       moritzseider   863333    107   863333   NaN     NaN            NaN       NaN
16          Roman Josi        D            80     23       73          romanjosi  9059000    215  9059000   NaN     NaN            NaN       NaN
17       Victor Hedman        D            82     20       65       victorhedman  7875000    190  7875000   NaN     NaN            NaN       NaN
18   Frederik Andersen        G            52      0        4   frederikandersen  4500000    133  4500000  35.0  1320.0          0.922       4.0
19     Jacob Markström        G            63      0        3     jacobmarkstrom  6000000    162  6000000  37.0  1617.0          0.922       9.0
```

Then, the solver executes a few trades:

```diff
Looking from September 2022 24 to October 2022 31
October 2022: 212
- Elias Lindholm 4850000 124
- Jonathan Huberdeau 5900000 145
- Kris Letang 6100000 146
- Moritz Seider 863333 107
- Roman Josi 9059000 215
+ David Pastrňák 6666667 24
+ Gabriel Vilardi 825000 21
+ Erik Karlsson 11500000 28
+ Rasmus Dahlin 6000000 30
+ Sebastian Aho 825000 24

Looking from October 2022 25 to November 2022 30
November 2022: 412
- Ryan Hartman 1700000 6
- Evan Bouchard 863333 8
- Victor Hedman 7875000 17
- Frederik Andersen 4500000 12
- Jacob Markström 6000000 12
+ Jason Robertson 7750000 46
+ Brandon Montour 3500000 38
+ Josh Morrissey 6250000 45
+ Logan Thompson 766667 32
+ Vítek Vaněček 3400000 38

Looking from November 2022 24 to December 2022 31
December 2022: 427
- J.T. Miller 5250000 26
- Trevor Zegras 925000 21
- Troy Terry 1450000 24
- Cale Makar 9000000 36
- Vítek Vaněček 3400000 38
+ Connor McDavid 12500000 53
+ Dylan Cozens 894167 26
+ Ryan Nugent-Hopkins 5125000 33
+ Erik Gustafsson 800000 36
+ Pyotr Kochetkov 842500 34

Looking from December 2022 25 to January 2023 31
January 2023: 439
- Jason Robertson 7750000 32
- Roope Hintz 3150000 29
- Josh Morrissey 6250000 49
- Logan Thompson 766667 18
- Pyotr Kochetkov 842500 34
+ Jack Hughes 8000000 40
+ Trevor Zegras 925000 25
+ Vince Dunn 4000000 41
+ Jake Oettinger 4000000 31
+ Martin Jones 2000000 37

Looking from January 2023 25 to February 2023 28
February 2023: 308
- David Pastrňák 6666667 38
- Gabriel Vilardi 825000 12
- Rasmus Dahlin 6000000 40
- Jake Oettinger 4000000 31
- Martin Jones 2000000 37
+ Claude Giroux 6500000 30
+ Dawson Mercer 894167 20
+ Josh Morrissey 6250000 29
+ Alexandar Georgiev 3400000 26
+ Ilya Samsonov 1800000 28

Looking from February 2023 22 to March 2023 31
March 2023: 455
- Jack Hughes 8000000 20
- Michael Bunting 950000 14
- Erik Gustafsson 800000 22
- Erik Karlsson 11500000 30
- Ilya Samsonov 1800000 28
+ Clayton Keller 7150000 42
+ Nathan MacKinnon 6300000 41
+ Evan Bouchard 863333 29
+ Miro Heiskanen 8450000 52
+ Stuart Skinner 750000 38

Looking from Mar 25, 2023 to Apr 30, 2023
April 2023: 249
```

And we end the year with 2502 points, with this team:

```
Total value: 2502 (124 to go)
                   name position  games_played  goals  assists    normalized_name   cap_hit  value    weight  wins   saves  saves_percent  shutouts
0         Claude Giroux        C            82      6       13       claudegiroux   6500000     25   6500000   NaN     NaN            NaN       NaN
1        Clayton Keller        C            82     13       16      claytonkeller   7150000     42   7150000   NaN     NaN            NaN       NaN
2        Connor McDavid        C            82     17       22      connormcdavid  12500000     56  12500000   NaN     NaN            NaN       NaN
3         Dawson Mercer        C            82      7        9       dawsonmercer    894167     23    894167   NaN     NaN            NaN       NaN
4          Dylan Cozens        C            81      8        6        dylancozens    894167     22    894167   NaN     NaN            NaN       NaN
5          Jordan Kyrou        C            79      9        6        jordankyrou   2800000     24   2800000   NaN     NaN            NaN       NaN
6        Leon Draisaitl        C            80     13       19      leondraisaitl   8500000     45   8500000   NaN     NaN            NaN       NaN
7      Nathan MacKinnon        C            71     13       15    nathanmackinnon   6300000     41   6300000   NaN     NaN            NaN       NaN
8   Ryan Nugent-Hopkins        C            82      8       18  ryannugenthopkins   5125000     34   5125000   NaN     NaN            NaN       NaN
9         Tage Thompson        C            78      8        9       tagethompson   1400000     25   1400000   NaN     NaN            NaN       NaN
10          Tim Stützle       LW            78     11       14         timstutzle    925000     36    925000   NaN     NaN            NaN       NaN
11        Trevor Zegras        C            81      3        8       trevorzegras    925000     14    925000   NaN     NaN            NaN       NaN
12      Brandon Montour        D            80      4       12     brandonmontour   3500000     36   3500000   NaN     NaN            NaN       NaN
13        Evan Bouchard        D            82      3       10       evanbouchard    863333     29    863333   NaN     NaN            NaN       NaN
14       Josh Morrissey        D            78      4        7      joshmorrissey   6250000     26   6250000   NaN     NaN            NaN       NaN
15       Miro Heiskanen        D            79      4       20      miroheiskanen   8450000     52   8450000   NaN     NaN            NaN       NaN
16        Sebastian Aho        D            71      9        9       sebastianaho    825000     45    825000   NaN     NaN            NaN       NaN
17           Vince Dunn        D            81      4       17          vincedunn   4000000     46   4000000   NaN     NaN            NaN       NaN
18   Alexandar Georgiev        G            16      0        0  alexandargeorgiev   3400000     48   3400000  11.0  1748.0       0.918562       3.0
19       Stuart Skinner        G            15      0        0      stuartskinner    750000     38    750000  11.0  1403.0       0.897667       1.0
```

With a naive approach for evaluating and trading players, we end up with quite a good amount of points!

### Future improvements and other ideas

Even though this constraint solver works fine and ranks ok, many changes, both big and small, could make the hockey pool picker faster, more efficient, and more reliable.

#### Overfitting, overfitting, overfitting!

I only tested with the past 2 seasons, as the process for sourcing and manually cleaning up data was lengthy. Testing across more seasons could allow for better backtesting. This would allow fine-tuning a value strategy. Furthermore, only regular season games data was sourced for reasons of simplicity. To get a better representation of a player's performance across an entire season, we could source playoff data as well.

#### Trading

I do all trades at the end of the month, not taking into consideration injuries. I tried taking into consideration injuries as they occurred, but finding a history of injuries for past seasons didn't seem possible without paying for some API access. This is the next thing I want to add to the trading simulator, as it's one of the most obvious opportunities for improvement.

#### Better value strategy

Instead of picking the value of a player according to the La Presse strategy, one could develop their own. The La Presse value-attributing strategy gives goalies 5 points if they score a goal, which seems a bit like gambling to me.

I've coded up some strategies which aren't currently used by the solver, since they ended up giving worse results than the La Presse Strategy:
* [La Presse minus gambling strategy](https://github.com/Spuffynism/hockey-pool-picker/blob/main/strategy.py#L59), where we remove the value given to a goalie from goals. I'm not sure why this didn't prove to be a better value strategy than the current one. I'd expect it to perform better across multiple seasons.
* [La Presse with doubled points for defenders strategy](https://github.com/Spuffynism/hockey-pool-picker/blob/main/strategy.py#L43), where the value attributed to defenders is doubled, in an attempt to take advantage of the fact that defenders get 3 and 2 points for goals and assists versus 2 and 1 points for forwards. Increasing points by 100% might be too much for defenders. Maybe lowering the value multiplication factor would lead to it becoming a better strategy.
* [Moneyball strategy](https://github.com/Spuffynism/hockey-pool-picker/blob/main/strategy.py#L48), where a forward and defender's value is determined by assists only. For goalies, we use the save percentage. I suspect in a context where we'd build a hockey team with players that actually play together, giving a lot of value to players who pass often would increase the opportunity of scoring, and would lead to more goals.
* [La Presse with percentage strategy](https://github.com/Spuffynism/hockey-pool-picker/blob/main/strategy.py#L64), where a forward and a defender's value is the percentage of theoretical points it could make (naively set to 250) in a season, and a goalie its save percentage. Giving more thought into the idea of "theoretical points" a player can score could lead to this becoming a better strategy.

One could use the popular Corsi/Fenwick statistic on a team-level, and factor that in the calculation for a player value (a player on a winning team probably has a better chance of gathering points than one on a losing team). But then again, [that might not suit you](http://rinkstats.com/2014/05/corsi-and-fenwick-suck-or-why-we-should), because it  does not reflect puck possession, which is usually a good indicator of team performance.

When picking trades, instead of looking back at the previous month plus 1 week, we could look back at the entire season, and exponentially give more value to data as it comes closer in time to the present. Intuitively, a variant of an exponential growth function could be a good candidate for this.

#### Array operations vectorization

Since the dataset of players is relatively small (~1300 players), the speed of non-vectorized operations is tolerable. However, to improve the speed and memory efficiency of calculating points per-month, per-player, we could vectorize these operations. This would allow backtesting the strategy across many seasons faster, whenever we implement that.

Along the same line, data is loaded from csv files to dataframes on every run. We should save files in the parquet format to make the startup time faster.

#### Evaluation mode

When picking trades, we could list past trades which ended up being bad ones. The current algorithm picks a goalie with a single game played at some point. This probably shouldn't happen, unless the upside of having a bad goalie is outweighed by having excellent other players. I haven't looked into why exactly this trade happens yet.

## Conclusion

We developed a solver that achieves a respectable ranking by using a constraint solver with a modified version of the knapsack algorithm. Then, we went through the pain of gathering, joining and cleaning data from different sources. Finally, we backtested the trading algorithm across the past season.

Unfortunately, our current score falls short of the top 5 positions [which could've won us an iPad mini](https://poolhockey.lapresse.ca/reglements.php)! Fortunately, we have a bunch of potential improvements we can apply to squeeze in a few more points. With the 2023-2024 season quickly approaching, we have strong motivation to do so. Let's see what it brings!

The full code is available at https://github.com/Spuffynism/hockey-pool-picker