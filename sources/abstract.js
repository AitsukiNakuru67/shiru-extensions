/** @typedef {import('../index.d.ts').TorrentSource} TorrentSource */

/** @implements {TorrentSource} */
export default class AbstractSource {
  /**
   * Query results for a single episode.
   * @type {import('../index.d.ts').SearchFunction}
   */
  single (options) {
    throw new Error('Source does not implement method #single()')
  }

  /**
   * Query results for a batch of episodes.
   * @type {import('../index.d.ts').SearchFunction}
   */
  batch (options) {
    throw new Error('Source does not implement method #batch()')
  }

  /**
   * Query results for a movie.
   * @type {import('../index.d.ts').SearchFunction}
   */
  movie (options) {
    throw new Error('Source does not implement method #movie()')
  }

  /**
   * Optional: return a structured release list (`.list.json` v2 or `RankResponse`) for Shiru's local ranker.
   * @type {import('../index.d.ts').ListFunction}
   */
  list (options) {
    return Promise.resolve(null)
  }

  /**
   * Validates the source url / settings.
   * @type {Promise<boolean>}
   */
  validate () {
    throw new Error('Source does not implement method #validate()')
  }
}
