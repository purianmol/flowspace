import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { api } from '../api/client.js';
import { getSocket } from '../socket.js';
import { positionBetween } from '../utils/position.js';
import ListColumn from '../components/ListColumn.jsx';
import CardModal from '../components/CardModal.jsx';
import ConflictDialog from '../components/ConflictDialog.jsx';
import ActivityPanel from '../components/ActivityPanel.jsx';
import { listColor } from '../theme.js';

// Group a flat, position-sorted card array into { listId: [cards] }, ensuring
// every list (even empty ones) has an entry.
function groupCards(lists, cards) {
  const byList = {};
  lists.forEach((l) => {
    byList[l._id] = [];
  });
  cards.forEach((c) => {
    (byList[c.list] ||= []).push(c);
  });
  return byList;
}

// Replace a card (matched by id) in place across the grouped state.
function replaceById(byList, card) {
  const next = {};
  for (const [listId, cards] of Object.entries(byList)) {
    next[listId] = cards.map((c) => (c._id === card._id ? card : c));
  }
  return next;
}

export default function BoardView() {
  const { id } = useParams();
  const [board, setBoard] = useState(null);
  const [lists, setLists] = useState([]);
  const [cardsByList, setCardsByList] = useState({});
  const [activeCard, setActiveCard] = useState(null);
  const [openCard, setOpenCard] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [activities, setActivities] = useState([]);
  const [activityCursor, setActivityCursor] = useState(null);
  const [showActivity, setShowActivity] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const sensors = useSensors(
    // A small drag threshold so a plain click still opens the card editor.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  useEffect(() => {
    setLoading(true);
    api
      .get(`/boards/${id}`)
      .then(({ data }) => {
        setBoard(data.board);
        setLists(data.lists);
        setCardsByList(groupCards(data.lists, data.cards));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    reloadActivities();
  }, [id]);

  // (Re)load the first page of history; also used to resync after a reconnect.
  async function reloadActivities() {
    try {
      const { data } = await api.get(`/boards/${id}/activity`);
      setActivities(data.activities);
      setActivityCursor(data.nextCursor);
    } catch {
      /* non-fatal */
    }
  }

  // Load an older page of history (cursor pagination).
  async function loadMoreActivity() {
    if (!activityCursor) return;
    const { data } = await api.get(`/boards/${id}/activity`, {
      params: { cursor: activityCursor },
    });
    setActivities((prev) => [...prev, ...data.activities]);
    setActivityCursor(data.nextCursor);
  }

  // Real-time sync: join this board's room and apply changes from other users.
  // Handlers are idempotent (keyed by id), so the originator's own echoed
  // events don't duplicate state — they converge on server truth.
  useEffect(() => {
    const socket = getSocket();

    socket.emit('board:join', id);

    // On reconnect, re-join the room and refresh everything missed while offline.
    function onReconnect() {
      socket.emit('board:join', id);
      api.get(`/boards/${id}`).then(({ data }) => {
        setBoard(data.board);
        setLists(data.lists);
        setCardsByList(groupCards(data.lists, data.cards));
      });
      reloadActivities();
    }

    function onCardCreated({ card }) {
      setCardsByList((prev) => {
        const listCards = prev[card.list] ?? [];
        const exists = listCards.some((c) => c._id === card._id);
        if (exists) return prev;
        return { ...prev, [card.list]: [...listCards, card] };
      });
    }

    function onCardUpdated({ card }) {
      setCardsByList((prev) => {
        // The card may have moved lists; remove from all then add to the right one.
        const next = {};
        let found = false;
        for (const [listId, cards] of Object.entries(prev)) {
          const filtered = cards.filter((c) => c._id !== card._id);
          next[listId] = String(listId) === String(card.list)
            ? [...filtered, card].sort((a, b) => a.position - b.position)
            : filtered;
          if (String(listId) === String(card.list)) found = true;
        }
        if (!found) next[card.list] = [card];
        return next;
      });
      // Keep the open modal in sync if the card being edited was updated remotely.
      setOpenCard((prev) => (prev?._id === card._id ? card : prev));
    }

    function onCardDeleted({ cardId }) {
      setCardsByList((prev) => {
        const next = {};
        for (const [listId, cards] of Object.entries(prev)) {
          next[listId] = cards.filter((c) => c._id !== cardId);
        }
        return next;
      });
      setOpenCard((prev) => (prev?._id === cardId ? null : prev));
    }

    function onListCreated({ list }) {
      setLists((prev) => {
        if (prev.some((l) => l._id === list._id)) return prev;
        return [...prev, list];
      });
      setCardsByList((prev) => (prev[list._id] ? prev : { ...prev, [list._id]: [] }));
    }

    function onListDeleted({ listId }) {
      setLists((prev) => prev.filter((l) => l._id !== listId));
      setCardsByList((prev) => {
        const next = { ...prev };
        delete next[listId];
        return next;
      });
    }

    function onActivityCreated({ activity }) {
      setActivities((prev) => [activity, ...prev]);
    }

    socket.on('connect', onReconnect);
    socket.on('card:created', onCardCreated);
    socket.on('card:updated', onCardUpdated);
    socket.on('card:deleted', onCardDeleted);
    socket.on('list:created', onListCreated);
    socket.on('list:deleted', onListDeleted);
    socket.on('activity:created', onActivityCreated);

    return () => {
      socket.emit('board:leave', id);
      socket.off('connect', onReconnect);
      socket.off('card:created', onCardCreated);
      socket.off('card:updated', onCardUpdated);
      socket.off('card:deleted', onCardDeleted);
      socket.off('list:created', onListCreated);
      socket.off('list:deleted', onListDeleted);
      socket.off('activity:created', onActivityCreated);
    };
  }, [id]);

  // ── Drag-and-drop ──────────────────────────────────────────────────────────

  function onDragStart({ active }) {
    if (active.data.current?.type === 'card') {
      setActiveCard(active.data.current.card);
    }
  }

  // Live preview while dragging: move the card ghost across lists instantly.
  function onDragOver({ active, over }) {
    if (!over || active.id === over.id) return;
    const from = active.data.current?.card?.list;
    const toList = over.data.current?.type === 'list'
      ? over.data.current.list._id
      : over.data.current?.card?.list;
    if (!from || !toList || from === toList) return;

    setCardsByList((prev) => {
      const fromCards = prev[from].filter((c) => c._id !== active.id);
      const toCards = [...(prev[toList] ?? []), { ...active.data.current.card, list: toList }];
      return { ...prev, [from]: fromCards, [toList]: toCards };
    });
    // Update the dragging card's list so subsequent onDragOver calls are correct.
    active.data.current.card = { ...active.data.current.card, list: toList };
  }

  async function onDragEnd({ active, over }) {
    setActiveCard(null);
    if (!over) return;

    const cardData = active.data.current?.card;
    if (!cardData) return;

    const to = over.data.current?.type === 'list'
      ? over.data.current.list._id
      : over.data.current?.card?.list ?? cardData.list;

    const items = [...(cardsByList[to] ?? [])];
    const oldIndex = items.findIndex((c) => c._id === active.id);
    const newIndex = over.data.current?.type === 'card'
      ? items.findIndex((c) => c._id === over.id)
      : items.length - 1;

    const reordered = arrayMove(items, oldIndex, Math.max(newIndex, 0));
    const idx = reordered.findIndex((c) => c._id === active.id);
    const position = positionBetween(reordered[idx - 1], reordered[idx + 1]);

    // Reflect the new position locally so future drags compute correctly.
    reordered[idx] = { ...reordered[idx], position, list: to };
    setCardsByList((prev) => ({ ...prev, [to]: reordered }));

    // The move is already applied optimistically above; if the server rejects
    // it, resync from the authoritative board state.
    try {
      await api.patch(`/cards/${active.id}`, { list: to, position });
    } catch (err) {
      setError(err.message);
      refetch();
    }
  }

  async function refetch() {
    const { data } = await api.get(`/boards/${id}`);
    setBoard(data.board);
    setLists(data.lists);
    setCardsByList(groupCards(data.lists, data.cards));
  }

  async function addList(e) {
    e.preventDefault();
    if (!newListTitle.trim()) return;
    try {
      const { data } = await api.post(`/boards/${id}/lists`, {
        title: newListTitle.trim(),
      });
      setLists((prev) => [...prev, data.list]);
      setCardsByList((prev) => ({ ...prev, [data.list._id]: [] }));
      setNewListTitle('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function addCard(listId, title) {
    const { data } = await api.post(`/lists/${listId}/cards`, { title });
    setCardsByList((prev) => ({ ...prev, [listId]: [...prev[listId], data.card] }));
  }

  async function deleteList(listId) {
    await api.delete(`/lists/${listId}`);
    setLists((prev) => prev.filter((l) => l._id !== listId));
    setCardsByList((prev) => {
      const next = { ...prev };
      delete next[listId];
      return next;
    });
  }

  // Optimistic edit: apply the change locally right away, then reconcile with
  // the server. A 409 means someone else edited first — surface a conflict
  // prompt rather than silently overwriting.
  async function saveCard(cardId, patch) {
    const previous = Object.values(cardsByList)
      .flat()
      .find((c) => c._id === cardId);

    // Optimistic local update.
    setCardsByList((prev) => {
      const next = {};
      for (const [listId, cards] of Object.entries(prev)) {
        next[listId] = cards.map((c) =>
          c._id === cardId
            ? { ...c, title: patch.title, description: patch.description }
            : c
        );
      }
      return next;
    });

    try {
      const { data } = await api.patch(`/cards/${cardId}`, patch);
      setCardsByList((prev) => replaceById(prev, data.card)); // adopt server truth
    } catch (err) {
      if (err.status === 409 && err.data?.card) {
        // Show the board the current server card, and open the merge prompt.
        setCardsByList((prev) => replaceById(prev, err.data.card));
        setConflict({
          attempted: { title: patch.title, description: patch.description },
          server: err.data.card,
        });
      } else {
        if (previous) setCardsByList((prev) => replaceById(prev, previous)); // rollback
        setError(err.message);
      }
    }
  }

  // Conflict resolution — re-apply my edit on top of the current version.
  async function resolveOverwrite() {
    const { attempted, server } = conflict;
    try {
      const { data } = await api.patch(`/cards/${server._id}`, {
        ...attempted,
        version: server.version,
      });
      setCardsByList((prev) => replaceById(prev, data.card));
      setConflict(null);
    } catch (err) {
      if (err.status === 409 && err.data?.card) {
        // Changed again in the meantime — refresh the comparison.
        setCardsByList((prev) => replaceById(prev, err.data.card));
        setConflict({ attempted, server: err.data.card });
      } else {
        setError(err.message);
        setConflict(null);
      }
    }
  }

  function resolveDiscard() {
    // Board already shows the server card; just close the prompt.
    setConflict(null);
  }

  async function deleteCard(cardId) {
    await api.delete(`/cards/${cardId}`);
    setCardsByList((prev) => {
      const next = {};
      for (const [listId, cards] of Object.entries(prev)) {
        next[listId] = cards.filter((c) => c._id !== cardId);
      }
      return next;
    });
    setOpenCard(null);
  }

  if (loading) return <div className="p-8 text-muted">Loading board…</div>;
  if (error && !board) return <div className="p-8 text-accent-ink">{error}</div>;

  return (
    <div className="px-6 py-6">
      <div className="mb-5 flex items-center gap-3">
        <Link
          to="/"
          className="rounded-lg border border-line bg-surface px-2.5 py-1 text-sm text-muted transition hover:text-ink"
        >
          ← Boards
        </Link>
        <h1 className="font-display text-2xl font-bold text-ink">{board?.title}</h1>
        <span className="ml-1 rounded-full bg-teal/15 px-2 py-0.5 text-xs font-medium text-teal">
          live
        </span>
        <button
          onClick={() => setShowActivity(true)}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition hover:border-ink/30 hover:shadow-sm"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-muted">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          History
          {activities.length > 0 && (
            <span className="rounded-full bg-ink/5 px-1.5 text-xs text-muted">
              {activities.length}
            </span>
          )}
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-accent-ink">{error}</p>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="board-scroll flex items-start gap-4 overflow-x-auto pb-4">
          {lists.map((list, i) => (
            <ListColumn
              key={list._id}
              list={list}
              color={listColor(i)}
              cards={cardsByList[list._id] || []}
              onAddCard={addCard}
              onDeleteList={deleteList}
              onOpenCard={setOpenCard}
            />
          ))}

          <form
            onSubmit={addList}
            className="w-72 shrink-0 rounded-xl border border-dashed border-line bg-surface/50 p-2.5"
          >
            <input
              value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              placeholder="+ Add another list"
              className="w-full rounded-lg bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
            />
          </form>
        </div>

        <DragOverlay>
          {activeCard ? (
            <div className="rotate-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm font-medium text-ink shadow-xl">
              {activeCard.title}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {openCard && (
        <CardModal
          card={openCard}
          onSave={saveCard}
          onDelete={deleteCard}
          onClose={() => setOpenCard(null)}
        />
      )}

      {conflict && (
        <ConflictDialog
          attempted={conflict.attempted}
          server={conflict.server}
          onOverwrite={resolveOverwrite}
          onDiscard={resolveDiscard}
        />
      )}

      <ActivityPanel
        open={showActivity}
        activities={activities}
        hasMore={!!activityCursor}
        onLoadMore={loadMoreActivity}
        onClose={() => setShowActivity(false)}
      />
    </div>
  );
}
